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

	// Same branded template as every Whensdays email, in the analytics-only
	// teal: headline stat as the lead line, then the funnel as tidy label/value
	// meta rows (the When/Where table style) instead of a text wall.
	total := 0
	meta := make([]emailMetaRow, 0, len(digestMetrics))
	for _, m := range digestMetrics {
		if n := counts[m.Event]; n > 0 {
			meta = append(meta, emailMetaRow{m.Label, fmt.Sprintf("%d", n)})
			total += n
		}
	}
	people := "people"
	if dau == 1 {
		people = "person"
	}
	lines := []string{fmt.Sprintf("👥 %d %s active · %d actions", dau, people, total)}
	if total == 0 && dau == 0 {
		lines = append(lines, "A quiet day - nothing recorded. Tomorrow's a new one.")
	}
	body := renderEmail(emailContent{
		preheader: fmt.Sprintf("%d active · %d actions yesterday.", dau, total),
		heading:   "📊 " + dayStart.Format("Monday, Jan 2"),
		lines:     lines,
		meta:      meta,
		ctaLabel:  "Open PostHog",
		ctaURL:    "https://us.posthog.com/project/" + project,
		logoURL:   s.logoURL(),
		theme:     "analytics",
	})
	s.notify.Send([]string{to}, fmt.Sprintf("Whensdays daily: %d active, %d actions", dau, total), body)
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "dau": dau, "actions": total})
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
