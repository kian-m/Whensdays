package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// analytics_digest.go - the owner's daily numbers, emailed. A second Cloud
// Scheduler job hits the CRON_KEY-gated endpoint each morning; it runs two
// HogQL queries against PostHog's Query API (a dedicated key scoped to
// Query:Read - never the ingest or personal key) and sends one branded email
// to ANALYTICS_DIGEST_TO. No-op (200, skipped) unless the key, project id,
// and recipient are all configured, mirroring every other integration here.

// digestMetrics: the funnel in the order the README cares about it.
var digestMetrics = []struct {
	Event string
	Label string
}{
	{"event_created", "Events created"},
	{"event_finalized", "Events locked in"},
	{"rsvp_submitted", "RSVPs"},
	{"poll_voted", "Poll votes"},
	{"general_voted", "Availability responses"},
	{"invite_opened", "Invites opened"},
	{"guest_joined", "Guests joined"},
	{"group_joined", "Group joins"},
	{"comment_posted", "Comments"},
	{"share_link_copied", "Invite shares"},
	{"qr_code_opened", "QR opens"},
	{"calendar_connected", "Calendars connected"},
}

func (s *server) handleCronAnalytics(w http.ResponseWriter, r *http.Request) {
	key := os.Getenv("CRON_KEY")
	if key == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Cron-Key")), []byte(key)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	phKey := os.Getenv("POSTHOG_QUERY_KEY")
	project := os.Getenv("POSTHOG_PROJECT_ID")
	to := os.Getenv("ANALYTICS_DIGEST_TO")
	if phKey == "" || project == "" || to == "" || !s.notify.Enabled() {
		writeJSON(w, http.StatusOK, map[string]any{"skipped": true})
		return
	}

	// Yesterday, Pacific - same day-boundary convention as every other cron.
	loc, lerr := time.LoadLocation(defaultTimeZone)
	if lerr != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	dayEnd := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	dayStart := dayEnd.AddDate(0, 0, -1)
	from, until := dayStart.UTC().Format("2006-01-02 15:04:05"), dayEnd.UTC().Format("2006-01-02 15:04:05")

	counts, err := s.hogqlEventCounts(r.Context(), phKey, project, from, until)
	if err != nil {
		s.internal(w, "analytics digest: query", err)
		return
	}
	dau, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(
		`select count(distinct distinct_id) from events where timestamp >= '%s' and timestamp < '%s' and event != 'api_request'`, from, until))

	// HERO - real signups from OUR database (email on file, not a guest id):
	// the number that actually matters, PostHog only decorates it.
	registered, _ := s.queries.CountRegisteredUsers(r.Context())
	newReg, _ := s.queries.CountNewRegisteredBetween(r.Context(), db.CountNewRegisteredBetweenParams{
		CreatedAt: pgtype.Timestamptz{Time: dayStart, Valid: true}, CreatedAt_2: pgtype.Timestamptz{Time: dayEnd, Valid: true},
	})

	// FUNNEL - unique people per stage yesterday, one grouped HogQL query.
	stages, _ := s.hogql(r.Context(), phKey, project, fmt.Sprintf(
		`select uniqIf(distinct_id, event = '$pageview'),
		        uniqIf(distinct_id, event = 'invite_opened'),
		        uniqIf(distinct_id, event in ('rsvp_submitted','poll_voted','general_voted')),
		        uniqIf(distinct_id, event = 'guest_joined'),
		        uniqIf(distinct_id, event = 'event_created')
		 from events where timestamp >= '%s' and timestamp < '%s'`, from, until))
	stage := func(i int) int {
		if len(stages) == 1 && i < len(stages[0]) {
			if n, ok := stages[0][i].(float64); ok {
				return int(n)
			}
		}
		return 0
	}
	rawFunnel := []struct {
		label string
		count int
	}{
		{"Visited", stage(0)},
		{"Opened an invite", stage(1)},
		{"Voted or RSVP'd", stage(2)},
		{"Joined as guest", stage(3)},
		{"Signed up", int(newReg)},
		{"Created an event", stage(4)},
	}
	first := rawFunnel[0].count
	funnel := make([]emailFunnelStep, 0, len(rawFunnel))
	prev := 0
	for i, f := range rawFunnel {
		st := emailFunnelStep{label: f.label, count: f.count}
		if first > 0 {
			st.width = f.count * 100 / first
		}
		if i > 0 && prev > 0 {
			st.drop = fmt.Sprintf("-%d%%", (prev-f.count)*100/prev)
			if f.count >= prev {
				st.drop = "±0%"
			}
		}
		prev = f.count
		funnel = append(funnel, st)
	}

	// LEADERBOARD - top hosts of the last 7 days: events created + people invited.
	board := []emailBoardRow{}
	if hosts, herr := s.queries.TopHostsSince(r.Context(), pgtype.Timestamptz{Time: now.AddDate(0, 0, -7), Valid: true}); herr == nil {
		for i, h := range hosts {
			name := h.DisplayName
			if name == "" {
				name = "(no name)"
			}
			board = append(board, emailBoardRow{
				rank: i + 1, name: name,
				value: fmt.Sprintf("%d %s · invited %d", h.EventsCreated, pluralWord(int(h.EventsCreated), "event", "events"), h.InvitesSent),
			})
		}
	}

	// FREE-TIER RUNWAY - where usage sits against each service's cliff, so the
	// upgrade happens BEFORE the silent failure. Limits are current published
	// tiers; update alongside pricing pages.
	const (
		resendDayLimit  = 100       // Resend free: emails/day
		resendMonLimit  = 3000      // Resend free: emails/month
		neonBytesLimit  = 512 << 20 // Neon free: 0.5 GB storage
		neonCUHourLimit = 100       // Neon free: 100 CU-hours of compute/month per project
		posthogMonLimit = 1_000_000 // PostHog free: events/month
		cfDayLimit      = 100_000   // Cloudflare Workers free: proxy requests/day
		klipyHourLimit  = 100       // Klipy TEST key: requests/hour
		clerkMAULimit   = 10_000    // Clerk free: monthly active (signed-in) users
	)
	monthStartT := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
	monthStart := monthStartT.UTC().Format("2006-01-02 15:04:05")
	nowUTC := now.UTC().Format("2006-01-02 15:04:05")
	// toIntOrDefault, NOT toInt64OrNull: HogQL's function allowlist rejects the
	// latter, and hogqlScalar's error is discarded here - so until this fix both
	// email bars silently read 0, leaving the Resend cliff (100/day, 3k/month -
	// the limit most likely to bite as invite/reminder volume grows) unwatched.
	const emailSentSum = `select sum(toIntOrDefault(toString(properties.recipients), 1)) from events where event = 'email_sent' and timestamp >= '%s' and timestamp < '%s'`
	emailsDay, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(emailSentSum, from, until))
	emailsMonth, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(emailSentSum, monthStart, nowUTC))
	phMonth, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(
		`select count() from events where timestamp >= '%s' and timestamp < '%s'`, monthStart, nowUTC))
	apiDay, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(
		`select count() from events where event = 'api_request' and timestamp >= '%s' and timestamp < '%s'`, from, until))
	klipyPeak, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(
		`select count() as c from events where event = 'api_request' and toString(properties.path) like '%%/api/gifs/%%' and timestamp >= '%s' and timestamp < '%s' group by toStartOfHour(timestamp) order by c desc limit 1`, from, until))
	dbBytes, _ := s.queries.DatabaseSizeBytes(r.Context())

	// NEON COMPUTE - the free tier's real binding limit (100 CU-hours per
	// project per month; compute autosuspends after 5 min idle and that is
	// fixed on Free). Two sources: Neon's consumption API when NEON_API_KEY +
	// NEON_PROJECT_ID are configured (exact), else an estimate derived from our
	// own api_request telemetry. The estimate is labeled "(est.)" so it can
	// never be read as the billed figure.
	neonCU, neonCUUnit := 0, fmt.Sprintf("%d CU-hr/mo", neonCUHourLimit)
	exact := false
	if nk, np := os.Getenv("NEON_API_KEY"), os.Getenv("NEON_PROJECT_ID"); nk != "" && np != "" {
		if cu, nerr := s.neonComputeCUHours(r.Context(), nk, np, monthStartT, now); nerr == nil {
			neonCU, exact = int(math.Round(cu)), true
		}
	}
	if !exact {
		// Estimate: Neon stays awake 5 minutes past the last query, so every
		// 5-minute bucket holding >=1 DB-touching request is ~5 minutes of
		// awake wall-clock time; x the Free plan's 0.25 CU compute size gives
		// CU-hours. The three excluded paths are the only routes that never
		// touch Postgres (handleCSPReport and the health checks do no DB work),
		// so excluding them keeps idle-probe traffic from inflating the count.
		buckets, _ := s.hogqlScalar(r.Context(), phKey, project, fmt.Sprintf(
			`select count(distinct toStartOfInterval(timestamp, interval 5 minute)) from events where event = 'api_request' and timestamp >= '%s' and timestamp < '%s' and toString(properties.path) not in ('/api/health','/healthz','/api/csp-report')`,
			monthStart, nowUTC))
		neonCU = int(math.Round(cuHoursFromAwakeBuckets(buckets, neonAwakeBucketMins, neonFreeComputeSize)))
		neonCUUnit += " (est.)"
	}

	tierStep := func(label string, used, limit int, unit string) emailFunnelStep {
		pct := 0
		if limit > 0 {
			pct = used * 100 / limit
		}
		return emailFunnelStep{
			label: label, count: used, width: pct,
			drop: fmt.Sprintf("· %d%% of %s", pct, unit),
			warn: pct >= 80,
		}
	}
	tiers := []emailFunnelStep{
		tierStep("Emails · yesterday", emailsDay, resendDayLimit, "100/day"),
		tierStep("Emails · this month", emailsMonth, resendMonLimit, "3k/mo"),
		tierStep("Database", int(dbBytes>>20), int(neonBytesLimit>>20), "512 MB"),
		tierStep("Neon compute · month", neonCU, neonCUHourLimit, neonCUUnit),
		tierStep("PostHog events · month", phMonth, posthogMonLimit, "1M/mo"),
		tierStep("API requests · yesterday", apiDay, cfDayLimit, "100k/day"),
		tierStep("GIF searches · peak hour", klipyPeak, klipyHourLimit, "100/hr (test key)"),
		tierStep("Registered users", int(registered), clerkMAULimit, "10k MAU"),
	}

	// Everything else from yesterday, compact.
	total := 0
	meta := make([]emailMetaRow, 0, len(digestMetrics))
	for _, m := range digestMetrics {
		if n := counts[m.Event]; n > 0 {
			meta = append(meta, emailMetaRow{m.Label, fmt.Sprintf("%d", n)})
			total += n
		}
	}
	sub := "steady"
	if newReg > 0 {
		sub = fmt.Sprintf("+%d yesterday 🎉", newReg)
	}
	body := renderEmail(emailContent{
		preheader: fmt.Sprintf("%d registered (+%d) · %d visitors · %d actions.", registered, newReg, stage(0), total),
		heading:   "📊 " + dayStart.Format("Monday, Jan 2"),
		hero:      &emailHero{number: fmt.Sprintf("%d", registered), label: "Registered users", sub: sub},
		funnelT:   "Yesterday's funnel",
		funnel:    funnel,
		boardT:    "Top hosts · last 7 days",
		board:     board,
		tiersT:    "Free-tier runway",
		tiers:     tiers,
		lines:     []string{fmt.Sprintf("👥 %d unique people did something yesterday.", dau)},
		meta:      meta,
		ctaLabel:  "Open PostHog",
		ctaURL:    "https://us.posthog.com/project/" + project,
		logoURL:   s.logoURL(),
		theme:     "analytics",
	})
	// Once-per-day gate: with scheduler retries enabled (and the odd manual
	// trigger), the digest must never send twice for the same run day. Claim
	// atomically right before sending - if another attempt already sent today
	// there's no row back, so skip. Claiming this late (after the queries
	// succeed) means a failed query doesn't burn the day's slot.
	runDay := pgtype.Date{Time: now, Valid: true} // now is Pacific; date part = today PT
	if _, err := s.queries.ClaimCronRun(r.Context(), db.ClaimCronRunParams{Job: "analytics", RunDay: runDay}); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"skipped": "already sent today"})
		return
	}
	s.notify.Send([]string{to}, fmt.Sprintf("Whensdays daily: %d registered (+%d), %d visitors", registered, newReg, stage(0)), body)
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "registered": registered, "new": newReg, "visitors": stage(0), "actions": total})
}

const (
	// neonFreeComputeSize: the Free plan's fixed compute size in CUs. The
	// telemetry estimate multiplies awake wall-clock time by it.
	neonFreeComputeSize = 0.25
	// neonAwakeBucketMins mirrors Neon's autosuspend delay: compute stays up
	// 5 minutes past the last query, so one active bucket ~= 5 awake minutes.
	neonAwakeBucketMins = 5
)

// cuHoursFromComputeSeconds converts Neon's compute_time_seconds (CU-SECONDS -
// already weighted by compute size, e.g. 1s at 0.25 CU = 0.25) into the
// CU-hours the 100/month free limit is metered in.
func cuHoursFromComputeSeconds(sec float64) float64 { return sec / 3600 }

// cuHoursFromAwakeBuckets estimates CU-hours from the number of distinct
// activity buckets that each kept the compute awake for bucketMins minutes.
func cuHoursFromAwakeBuckets(buckets, bucketMins int, computeSize float64) float64 {
	if buckets <= 0 || bucketMins <= 0 {
		return 0
	}
	return float64(buckets) * float64(bucketMins) / 60 * computeSize
}

// neonConsumption mirrors Neon's documented API v2 consumption-history shape
// (projects → periods → consumption). UNVERIFIED against a live response - no
// Neon API key exists in this environment - so it is decoded permissively: a
// renamed or missing level simply yields zero, never a panic.
type neonConsumption struct {
	Projects []struct {
		Periods []struct {
			Consumption []struct {
				ComputeTimeSeconds float64 `json:"compute_time_seconds"`
			} `json:"consumption"`
		} `json:"periods"`
	} `json:"projects"`
}

// neonComputeCUHours reports the project's compute burn since `from` in
// CU-hours. It sums compute_time_seconds across every entry returned for the
// window (the Pacific month start can straddle two of Neon's UTC billing
// periods). active_time_seconds is deliberately NOT used - that is wall-clock
// active time, not CU-weighted, and would overstate usage below 1 CU.
func (s *server) neonComputeCUHours(ctx context.Context, key, project string, from, to time.Time) (float64, error) {
	u := fmt.Sprintf("https://console.neon.tech/api/v2/consumption_history/projects?project_ids=%s&from=%s&to=%s&granularity=monthly",
		url.QueryEscape(project), url.QueryEscape(from.UTC().Format(time.RFC3339)), url.QueryEscape(to.UTC().Format(time.RFC3339)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	resp, err := safeHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("neon consumption: %s: %s", resp.Status, truncate(string(raw), 200))
	}
	var out neonConsumption
	if err := json.Unmarshal(raw, &out); err != nil {
		return 0, err
	}
	sec := 0.0
	for _, p := range out.Projects {
		for _, per := range p.Periods {
			for _, c := range per.Consumption {
				sec += c.ComputeTimeSeconds
			}
		}
	}
	return cuHoursFromComputeSeconds(sec), nil
}

func pluralWord(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// hogqlEventCounts: one grouped query for every digest metric.
func (s *server) hogqlEventCounts(ctx context.Context, key, project, from, until string) (map[string]int, error) {
	events := ""
	for i, m := range digestMetrics {
		if i > 0 {
			events += ","
		}
		events += "'" + m.Event + "'"
	}
	q := fmt.Sprintf(`select event, count() from events where timestamp >= '%s' and timestamp < '%s' and event in (%s) group by event`, from, until, events)
	rows, err := s.hogql(ctx, key, project, q)
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, row := range rows {
		if len(row) != 2 {
			continue
		}
		name, _ := row[0].(string)
		if n, ok := row[1].(float64); ok {
			out[name] = int(n)
		}
	}
	return out, nil
}

func (s *server) hogqlScalar(ctx context.Context, key, project, query string) (int, error) {
	rows, err := s.hogql(ctx, key, project, query)
	if err != nil || len(rows) == 0 || len(rows[0]) == 0 {
		return 0, err
	}
	if n, ok := rows[0][0].(float64); ok {
		return int(n), nil
	}
	return 0, nil
}

// hogql runs one query against PostHog's Query API (the APP host, not the
// ingest host) and returns the raw result rows.
func (s *server) hogql(ctx context.Context, key, project, query string) ([][]any, error) {
	host := os.Getenv("POSTHOG_APP_HOST")
	if host == "" {
		host = "https://us.posthog.com"
	}
	payload, _ := json.Marshal(map[string]any{"query": map[string]any{"kind": "HogQLQuery", "query": query}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, host+"/api/projects/"+project+"/query", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := safeHTTPClient(20 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("posthog query: %s: %s", resp.Status, truncate(string(raw), 200))
	}
	var out struct {
		Results [][]any `json:"results"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out.Results, nil
}
