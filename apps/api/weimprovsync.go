package main

// weimprovsync.go - keeps the We Improv (weimprov.org, an LA improv theatre)
// jam series in a group current with the venue's real schedule. Like WGIS, this
// is a clean server-side JSON fetch - NO scraper and NO browser: We Improv runs
// on Squarespace, whose every page exposes a built-in JSON export by appending
// ?format=json, so the app fetches + parses it directly and drives the shared
// engine (venuesync.go). autoCreate is ON (a curated single-venue feed, so a
// missing jam becomes a new series from the feed) and its poster is pulled in as
// the cover.
//
//   POST /api/cron/weimprov-sync   (CRON_KEY-gated)
//   {"group_id": "..."}            (no shows body; the server fetches the feed)
//
// Feed shape differs from WGIS in one important way: We Improv's feed is FLAT -
// every occurrence is its own top-level item with a single startDate (epoch
// millis), whereas crowdwork bundles all of a show's recurring dates into one
// item's `dates` array. So the loop here mirrors UCB's per-item iteration, not
// WGIS's nested per-date loop.
//
// FILTER: only titles containing "jam" (case-insensitive) sync, identical to
// WGIS. As of this writing We Improv posts no jams, so this legitimately matches
// nothing on every run (handled as a 200 no-op, not an error) - the mechanism is
// in place so the moment a jam is listed it flows through automatically. The
// stub mode exercises the full pipeline with fake jam-titled entries.
//
// WEIMPROV_MODE=stub serves a fixed in-memory feed (network-free) for E2E.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	weimprovBotID     = "weimprov-bot"
	weimprovBotName   = "We Improv Schedule"
	weimprovBotHandle = "weimprov-schedule-bot"
	weimprovFeedURL   = "https://weimprov.org/shows?format=json"
	// Real venue address (the feed's structured location is generic Squarespace
	// map data); no zip was confirmed, so none is fabricated.
	weimprovAddress = "6075 Franklin Ave, Los Angeles, CA"
)

// weimprovFeed is the Squarespace ?format=json export; only `upcoming` matters
// (past + the many unrelated site-config keys are ignored).
type weimprovFeed struct {
	Upcoming []weimprovEvent `json:"upcoming"`
}

// weimprovEvent is one occurrence (the feed is flat - one date per item).
type weimprovEvent struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	StartDate int64  `json:"startDate"` // epoch milliseconds
	Body      string `json:"body"`      // messy Squarespace block HTML (incl. <style>)
	AssetURL  string `json:"assetUrl"`  // image asset base; append ?format=750w
}

func (s *server) handleCronWeimprovSync(w http.ResponseWriter, r *http.Request) {
	key := os.Getenv("CRON_KEY")
	if key == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Cron-Key")), []byte(key)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var in struct {
		GroupID string `json:"group_id"`
	}
	if !decodeJSONLimit(w, r, &in, 1<<16) {
		return
	}
	gid, ok := parseUUID(in.GroupID)
	if !ok {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "valid group_id required"})
		return
	}
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		s.internal(w, "weimprov sync: tz", err)
		return
	}

	shows, err := s.fetchWeimprovShows(r.Context())
	if err != nil {
		s.internal(w, "weimprov sync: fetch feed", err)
		return
	}

	// Keep only JAMS; bucket by series key, then LA calendar day. Flat feed, so
	// one item = one occurrence (UCB-style loop, not WGIS's nested per-date one).
	series := map[string]venueSeries{}
	for _, sh := range shows {
		if !strings.Contains(strings.ToLower(sh.Title), "jam") {
			continue
		}
		if sh.StartDate == 0 {
			continue
		}
		at := time.UnixMilli(sh.StartDate).In(loc)
		k := seriesKey(sh.Title)
		vs, ok := series[k]
		if !ok {
			cover := ""
			if sh.AssetURL != "" {
				cover = sh.AssetURL + "?format=750w"
			}
			vs = venueSeries{
				title:       sh.Title,
				eventType:   "openmic", // a jam = open participation
				description: htmlToText(stripStyleScript(sh.Body)),
				coverURL:    cover,
				days:        map[string]venueSlot{},
			}
		}
		vs.days[at.Format("2006-01-02")] = venueSlot{at: at, venue: weimprovAddress}
		series[k] = vs
	}
	if len(series) == 0 {
		writeJSON(w, http.StatusOK, venueSyncStats{}) // no jams listed - expected today, fine
		return
	}

	st, err := s.syncVenueSeries(r.Context(), gid, series, venueSyncOpts{
		botID: weimprovBotID, botName: weimprovBotName, botHandle: weimprovBotHandle, autoCreate: true, loc: loc,
	})
	if err != nil {
		s.internal(w, "weimprov sync", err)
		return
	}
	s.analytics.Capture(weimprovBotID, "weimprov_sync_ran", map[string]any{
		"group_id": in.GroupID, "series": len(series),
		"adopted": st.Adopted, "created": st.Created, "retimed": st.Retimed, "cancelled": st.Cancelled,
	})
	writeJSON(w, http.StatusOK, st)
}

// fetchWeimprovShows returns the Squarespace `upcoming` list (or a fixed stub
// under WEIMPROV_MODE=stub). The payload carries `past` + lots of unrelated
// site config, so the read cap is generous (8MB) and only `upcoming` is decoded.
func (s *server) fetchWeimprovShows(ctx context.Context) ([]weimprovEvent, error) {
	if s.weimprovStub {
		return stubWeimprovShows(), nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, weimprovFeedURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := safeHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var out weimprovFeed
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Upcoming, nil
}

var styleScriptTag = regexp.MustCompile(`(?is)<(style|script)\b[^>]*>.*?</(style|script)>`)

// stripStyleScript removes <style>/<script> blocks (tag AND contents) before
// htmlToText runs - Squarespace bodies embed raw CSS in <style> blocks that
// htmlToText (tags only, not contents) would otherwise leave as text.
func stripStyleScript(s string) string {
	return styleScriptTag.ReplaceAllString(s, "")
}

// stubWeimprovShows: fixed, network-free feed for WEIMPROV_MODE=stub (hermetic
// E2E). Two jams (Drop-In Jam x3 dates, Sunday Jam x2) so the engine's
// auto-create + fan-out are exercised deterministically; the flat one-date-per-
// item shape mirrors the real feed. Each item carries a non-empty AssetURL so
// the cover path runs (fetch is stubbed) and a Body with <style> junk + real
// text so the HTML-cleanup path is actually exercised.
func stubWeimprovShows() []weimprovEvent {
	// Anchor on a fixed base so the test can predict dates; dev mode is exempt
	// from the past-date guard, and the sync skips days before "today" anyway,
	// so use dates comfortably in the future relative to any test run. Build an
	// explicit RFC3339 string with the offset (mirrors WGIS's stub) rather than
	// truncating an absolute instant to 24h - that rounds to UTC midnight, not
	// Pacific midnight, which silently shifts the calendar date by one whenever
	// the test happens to run while UTC and Pacific are on different dates.
	base := time.Now().In(time.FixedZone("PT", -7*3600))
	ms := func(days int) int64 {
		iso := base.AddDate(0, 0, days).Format("2006-01-02") + "T19:00:00-07:00"
		t, err := time.Parse(time.RFC3339, iso)
		if err != nil {
			panic(err) // stub-only, fixed format - a parse failure means the format string itself is wrong
		}
		return t.UnixMilli()
	}
	dropBody := `<style>.sqs-block{color:red}</style><div class="sqs-layout"><p>Drop in and jam with us! All levels welcome.</p></div>`
	sunBody := `<div><script>console.log('x')</script>The Sunday Jam &mdash; every 2nd &amp; 4th Sunday.</div>`
	return []weimprovEvent{
		{ID: "d1", Title: "Drop-In Jam", StartDate: ms(3), Body: dropBody, AssetURL: "stub://poster"},
		{ID: "d2", Title: "Drop-In Jam", StartDate: ms(10), Body: dropBody, AssetURL: "stub://poster"},
		{ID: "d3", Title: "Drop-In Jam", StartDate: ms(17), Body: dropBody, AssetURL: "stub://poster"},
		{ID: "s1", Title: "Sunday Jam", StartDate: ms(6), Body: sunBody, AssetURL: "stub://poster"},
		{ID: "s2", Title: "Sunday Jam", StartDate: ms(20), Body: sunBody, AssetURL: "stub://poster"},
	}
}
