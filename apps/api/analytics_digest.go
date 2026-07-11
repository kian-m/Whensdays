package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
		lines:     []string{fmt.Sprintf("👥 %d unique people did something yesterday.", dau)},
		meta:      meta,
		ctaLabel:  "Open PostHog",
		ctaURL:    "https://us.posthog.com/project/" + project,
		logoURL:   s.logoURL(),
		theme:     "analytics",
	})
	s.notify.Send([]string{to}, fmt.Sprintf("Whensdays daily: %d registered (+%d), %d visitors", registered, newReg, stage(0)), body)
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "registered": registered, "new": newReg, "visitors": stage(0), "actions": total})
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
