package main

// buzzmillsync.go - keeps the Buzz Mill (buzzmillcoffee.com, an Austin bar with
// a long-running weekly stand-up comedy program) comedy series in a group
// current with the venue's real schedule. Like We Improv this is a clean
// server-side JSON fetch - NO scraper and NO browser: Buzz Mill runs on
// Squarespace, whose every page exposes a built-in JSON export by appending
// ?format=json, so the app fetches + parses it directly and drives the shared
// engine (venuesync.go). autoCreate is ON (a curated single-venue feed, so a
// missing comedy night becomes a new series from the feed) and its poster is
// pulled in as the cover.
//
//   POST /api/cron/buzzmill-sync   (CRON_KEY-gated)
//   {"group_id": "..."}            (no shows body; the server fetches the feed)
//
// Feed shape is IDENTICAL to We Improv's (same Squarespace ?format=json export):
// FLAT - every occurrence is its own top-level `upcoming` item with a single
// startDate (epoch millis). So the loop mirrors We Improv's / UCB's per-item
// iteration, not WGIS's nested per-date loop.
//
// FILTER: only titles containing "comedy" (case-insensitive) sync. This was
// chosen EMPIRICALLY from the real feed, which mixes many event kinds - the
// recurring stand-up nights ("Buzz Kill Comedy", "Riverside Wranglers Comedy
// Show") both carry "comedy", while the non-comedy programming ("Monday Music
// Open Mic" - a MUSIC mic, "Unknown Trivia", DJ sets, park cleanups) does not.
// Note "open mic" would be exactly WRONG here: the only "open mic" in the feed
// is the music one. Buzz Mill's stand-up nights are booked showcases rather
// than open mics, so they map to the 'openmic' preset by its codebase meaning
// ("open mic / showcase night", migration 0021), not by literal format.
//
// TZ: Austin is Central time (America/Chicago), unlike the LA improv venues.
//
// BUZZMILL_MODE=stub serves a fixed in-memory feed (network-free) for E2E.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	buzzmillBotID     = "buzzmill-bot"
	buzzmillBotName   = "Buzz Mill Schedule"
	buzzmillBotHandle = "buzzmill-schedule-bot"
	buzzmillFeedURL   = "https://www.buzzmillcoffee.com/austin-buzzmill-events?format=json"
	// The feed's structured location is generic Squarespace map data; this is the
	// real place (confirmed from the feed's location block).
	buzzmillAddress = "1505 Town Creek Dr, Austin, TX 78741"
)

// buzzmillFeed is the Squarespace ?format=json export; only `upcoming` matters
// (past + the many unrelated site-config keys are ignored).
type buzzmillFeed struct {
	Upcoming []buzzmillEvent `json:"upcoming"`
}

// buzzmillEvent is one occurrence (the feed is flat - one date per item).
type buzzmillEvent struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	StartDate int64  `json:"startDate"` // epoch milliseconds
	Body      string `json:"body"`      // messy Squarespace block HTML (incl. <style>)
	AssetURL  string `json:"assetUrl"`  // image asset base; append ?format=750w
}

func (s *server) handleCronBuzzmillSync(w http.ResponseWriter, r *http.Request) {
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
	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		s.internal(w, "buzzmill sync: tz", err)
		return
	}

	shows, err := s.fetchBuzzmillShows(r.Context())
	if err != nil {
		s.internal(w, "buzzmill sync: fetch feed", err)
		return
	}

	// Keep only COMEDY; bucket by series key, then Central calendar day. Flat
	// feed, so one item = one occurrence (per-item loop, not WGIS's nested one).
	series := map[string]venueSeries{}
	for _, sh := range shows {
		if !strings.Contains(strings.ToLower(sh.Title), "comedy") {
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
				eventType:   "openmic", // codebase meaning: "open mic / showcase night"
				description: htmlToText(stripStyleScript(sh.Body)),
				coverURL:    cover,
				days:        map[string]venueSlot{},
			}
		}
		vs.days[at.Format("2006-01-02")] = venueSlot{at: at, venue: buzzmillAddress}
		series[k] = vs
	}
	if len(series) == 0 {
		writeJSON(w, http.StatusOK, venueSyncStats{}) // no comedy listed - fine
		return
	}

	st, err := s.syncVenueSeries(r.Context(), gid, series, venueSyncOpts{
		botID: buzzmillBotID, botName: buzzmillBotName, botHandle: buzzmillBotHandle, autoCreate: true, loc: loc,
	})
	if err != nil {
		s.internal(w, "buzzmill sync", err)
		return
	}
	s.analytics.Capture(buzzmillBotID, "buzzmill_sync_ran", map[string]any{
		"group_id": in.GroupID, "series": len(series),
		"adopted": st.Adopted, "created": st.Created, "retimed": st.Retimed, "cancelled": st.Cancelled,
	})
	writeJSON(w, http.StatusOK, st)
}

// fetchBuzzmillShows returns the Squarespace `upcoming` list (or a fixed stub
// under BUZZMILL_MODE=stub). The payload carries `past` + lots of unrelated
// site config, so the read cap is generous (8MB) and only `upcoming` is decoded.
func (s *server) fetchBuzzmillShows(ctx context.Context) ([]buzzmillEvent, error) {
	if s.buzzmillStub {
		return stubBuzzmillShows(), nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, buzzmillFeedURL, nil)
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
	var out buzzmillFeed
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Upcoming, nil
}

// stubBuzzmillShows: fixed, network-free feed for BUZZMILL_MODE=stub (hermetic
// E2E). Two comedy series (Buzz Kill Comedy x3 dates, Riverside Wranglers x2)
// so the engine's auto-create + fan-out are exercised deterministically, PLUS a
// non-comedy decoy ("Monday Music Open Mic") so the "comedy" filter is actually
// exercised (it must NOT sync). The flat one-date-per-item shape mirrors the
// real feed; each comedy item carries a non-empty AssetURL so the cover path
// runs (fetch is stubbed) and a Body with <style> junk + real text so the
// HTML-cleanup path is exercised.
func stubBuzzmillShows() []buzzmillEvent {
	// Anchor on a fixed base so the test can predict dates; dev mode is exempt
	// from the past-date guard, and the sync skips days before "today" anyway,
	// so use dates comfortably in the future relative to any test run. Build an
	// explicit RFC3339 string with the Central offset (mirrors We Improv's stub)
	// rather than truncating an absolute instant to 24h - that rounds to UTC
	// midnight, not Central midnight, which silently shifts the calendar date by
	// one whenever the test runs while UTC and Central are on different dates.
	base := time.Now().In(time.FixedZone("CT", -5*3600))
	ms := func(days int) int64 {
		iso := base.AddDate(0, 0, days).Format("2006-01-02") + "T21:00:00-05:00"
		t, err := time.Parse(time.RFC3339, iso)
		if err != nil {
			panic(err) // stub-only, fixed format - a parse failure means the format string itself is wrong
		}
		return t.UnixMilli()
	}
	killBody := `<style>.sqs-block{color:red}</style><div class="sqs-layout"><p>Buzz Mill's long-running (free) stand-up comedy showcase. All welcome!</p></div>`
	wranBody := `<div><script>console.log('x')</script>The Riverside Wranglers &mdash; a new headliner &amp; the best of Austin stand-up.</div>`
	return []buzzmillEvent{
		{ID: "b1", Title: "Buzz Kill Comedy", StartDate: ms(3), Body: killBody, AssetURL: "stub://poster"},
		{ID: "b2", Title: "Buzz Kill Comedy", StartDate: ms(10), Body: killBody, AssetURL: "stub://poster"},
		{ID: "b3", Title: "Buzz Kill Comedy", StartDate: ms(17), Body: killBody, AssetURL: "stub://poster"},
		{ID: "r1", Title: "Riverside Wranglers Comedy Show", StartDate: ms(6), Body: wranBody, AssetURL: "stub://poster"},
		{ID: "r2", Title: "Riverside Wranglers Comedy Show", StartDate: ms(20), Body: wranBody, AssetURL: "stub://poster"},
		// Decoy: a MUSIC open mic - must be filtered out by the "comedy" filter.
		{ID: "m1", Title: "Monday Music Open Mic", StartDate: ms(2), Body: "<p>music</p>", AssetURL: "stub://poster"},
	}
}
