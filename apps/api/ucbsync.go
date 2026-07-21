package main

// ucbsync.go - keeps the UCB jam series in a group current with the venue's
// real schedule. UCB sits behind a Cloudflare challenge that blocks plain HTTP
// and headless browsers, so the scrape+parse lives OUTSIDE this service
// (e2e/scripts/ucb-sync.mjs, a headed browser run monthly). It POSTs the
// parsed shows here; the shared engine (venuesync.go) owns the reconciliation:
//
//   POST /api/cron/ucb-sync   (CRON_KEY-gated)
//   {"group_id": "...", "shows": [{"title": "...", "starts": "2026-08-14 17:30", "venue": "..."}]}
//
// autoCreate is OFF: only titles ALREADY in the group are maintained, so a
// broad scrape can't flood it (seed one occurrence to start tracking a show).

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
	"time"
)

const ucbBotID = "ucb-bot"
const ucbBotName = "UCB Schedule"
const ucbBotHandle = "ucb-schedule-bot"

type ucbShow struct {
	Title  string `json:"title"`
	Starts string `json:"starts"` // "YYYY-MM-DD HH:MM" in the venue's local time
	Venue  string `json:"venue"`  // optional location_address override
}

func (s *server) handleCronUCBSync(w http.ResponseWriter, r *http.Request) {
	key := os.Getenv("CRON_KEY")
	if key == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Cron-Key")), []byte(key)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var in struct {
		GroupID string    `json:"group_id"`
		Shows   []ucbShow `json:"shows"`
	}
	if !decodeJSONLimit(w, r, &in, 1<<20) {
		return
	}
	gid, ok := parseUUID(in.GroupID)
	if !ok {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "valid group_id required"})
		return
	}
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		s.internal(w, "ucb sync: tz", err)
		return
	}

	// Bucket the posted shows by series key, then by LA calendar day (one show
	// per title+day; the jams never run twice a day, last wins).
	series := map[string]venueSeries{}
	for _, sh := range in.Shows {
		at, perr := time.ParseInLocation("2006-01-02 15:04", sh.Starts, loc)
		if perr != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid starts (want YYYY-MM-DD HH:MM): " + sh.Starts})
			return
		}
		k := seriesKey(sh.Title)
		vs, ok := series[k]
		if !ok {
			vs = venueSeries{title: sh.Title, days: map[string]venueSlot{}}
		}
		vs.days[at.Format("2006-01-02")] = venueSlot{at: at, venue: strings.TrimSpace(sh.Venue)}
		series[k] = vs
	}
	if len(series) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "no shows"})
		return
	}

	st, err := s.syncVenueSeries(r.Context(), gid, series, venueSyncOpts{
		botID: ucbBotID, botName: ucbBotName, botHandle: ucbBotHandle, loc: loc,
	})
	if err != nil {
		s.internal(w, "ucb sync", err)
		return
	}
	s.analytics.Capture(ucbBotID, "ucb_sync_ran", map[string]any{
		"group_id": in.GroupID, "shows": len(in.Shows),
		"adopted": st.Adopted, "created": st.Created, "retimed": st.Retimed, "cancelled": st.Cancelled,
	})
	writeJSON(w, http.StatusOK, st)
}
