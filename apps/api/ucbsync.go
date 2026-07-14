package main

// ucbsync.go - keeps the UCB jam series in a group current with the venue's
// real schedule. The scraper (e2e/scripts/ucb-sync.mjs, run monthly - it needs
// a real browser to pass UCB's Cloudflare challenge, so it does NOT live in
// this service) extracts upcoming shows from ucbcomedy.com and POSTs them
// here; this endpoint owns ALL the logic, so it stays hermetically testable:
//
//   POST /api/cron/ucb-sync   (CRON_KEY-gated, like the other cron routes)
//   {"group_id": "...", "shows": [{"title": "...", "starts": "2026-08-14 17:30", "venue": "..."}]}
//
// Per payload title that matches an existing event title in the group
// (case-insensitive; unknown titles are IGNORED so a broad scrape can't flood
// the group):
//   - adopt: occurrences are re-hosted to the bot profile ("ucb-bot", not a
//     group member) and the previous host becomes a cohost - they keep full
//     manage powers in the UI while the sync owns the series.
//   - add: payload dates the series doesn't have yet become sibling
//     occurrences (content + cover/theme copied from the latest occurrence).
//   - retime: same LA calendar date, different clock time -> starts_at moves
//     and the day-before reminder re-arms.
//   - cancel: a future occurrence inside the payload's observed date range
//     for that title that is NOT in the payload was pulled from the venue's
//     schedule -> quiet soft-cancel (no email fan-out; scrape absence is
//     weaker evidence than a host's explicit cancel). Dates beyond the
//     scrape horizon are left alone.
//
// Idempotent: re-posting the same payload is a no-op.

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/clsandbox/api/internal/db"

	"github.com/jackc/pgx/v5/pgtype"
)

const ucbBotID = "ucb-bot"
const ucbBotName = "UCB Schedule"
const ucbBotHandle = "ucb-schedule-bot"

type ucbShow struct {
	Title  string `json:"title"`
	Starts string `json:"starts"` // "YYYY-MM-DD HH:MM" in the venue's local time
	Venue  string `json:"venue"`  // optional location_address override for new dates
}

// seriesKey normalizes a show title to the recurring series it belongs to:
// lowercased, cut at the first guest/subtitle separator, punctuation dropped.
// UCB decorates titles per occurrence ("Strawberry Jam, hosted by "Ladies
// Night"", "Harold Night ft. S.O.F.T."), so exact matching would silently
// break the moment a listing gains a subtitle. Two DIFFERENT group events
// sharing a prefix before a separator would merge - name them distinctly.
func seriesKey(title string) string {
	t := strings.ToLower(strings.TrimSpace(title))
	for _, sep := range []string{":", ",", "(", " ft.", " ft ", " feat", " hosted by", " with "} {
		if i := strings.Index(t, sep); i > 0 {
			t = t[:i]
		}
	}
	// Keep letters/digits, collapse everything else to single spaces.
	var b strings.Builder
	space := false
	for _, r := range t {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		} else {
			space = true
		}
	}
	return b.String()
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

	// Parse + bucket the payload by series key, then by LA calendar day.
	// One show per title+day (the jams never run twice a day; last wins).
	type slot struct {
		at    time.Time
		venue string
	}
	payload := map[string]map[string]slot{} // title -> "YYYY-MM-DD" -> slot
	for _, sh := range in.Shows {
		at, perr := time.ParseInLocation("2006-01-02 15:04", sh.Starts, loc)
		if perr != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid starts (want YYYY-MM-DD HH:MM): " + sh.Starts})
			return
		}
		t := seriesKey(sh.Title)
		if payload[t] == nil {
			payload[t] = map[string]slot{}
		}
		payload[t][at.Format("2006-01-02")] = slot{at: at, venue: strings.TrimSpace(sh.Venue)}
	}
	if len(payload) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "no shows"})
		return
	}

	// The bot exists lazily; a handle collision with a real user is a hard
	// error we'd rather see than silently impersonate around.
	if _, err := s.queries.UpsertProfile(r.Context(), db.UpsertProfileParams{UserID: ucbBotID, DisplayName: ucbBotName, Handle: ucbBotHandle}); err != nil {
		s.internal(w, "ucb sync: bot profile", err)
		return
	}

	events, err := s.queries.ListGroupEvents(r.Context(), gid)
	if err != nil {
		s.internal(w, "ucb sync: list group events", err)
		return
	}
	byTitle := map[string][]db.Event{}
	for _, ev := range events {
		byTitle[seriesKey(ev.Title)] = append(byTitle[seriesKey(ev.Title)], ev)
	}

	now := time.Now().In(loc)
	today := now.Format("2006-01-02")
	var adopted, created, retimed, cancelled int
	var unmatched []string
	for title, days := range payload {
		occs := byTitle[title]
		if len(occs) == 0 {
			unmatched = append(unmatched, title)
			continue
		}
		// Adopt: bot becomes host everywhere, prior host keeps manage as cohost.
		for _, ev := range occs {
			if ev.HostID == ucbBotID {
				continue
			}
			if err := s.queries.SetEventHost(r.Context(), db.SetEventHostParams{ID: ev.ID, HostID: ucbBotID}); err != nil {
				s.internal(w, "ucb sync: adopt", err)
				return
			}
			_ = s.queries.AddCohost(r.Context(), db.AddCohostParams{EventID: ev.ID, UserID: ev.HostID})
			adopted++
		}
		// The series id (grow a lone matched event into a series if needed),
		// the template (latest occurrence carries the freshest content), and
		// the existing occurrence per LA day.
		series := pgtype.UUID{}
		template := occs[0]
		haveDay := map[string]db.Event{}
		minDay, maxDay := "9999-99-99", ""
		for d := range days {
			if d < minDay {
				minDay = d
			}
			if d > maxDay {
				maxDay = d
			}
		}
		for _, ev := range occs {
			if ev.SeriesID.Valid {
				series = ev.SeriesID
			}
			if ev.StartsAt.Valid {
				haveDay[ev.StartsAt.Time.In(loc).Format("2006-01-02")] = ev
				if template.StartsAt.Valid && ev.StartsAt.Time.After(template.StartsAt.Time) {
					template = ev
				}
			}
		}
		if !series.Valid {
			series = newUUID()
			if err := s.queries.SetSeries(r.Context(), db.SetSeriesParams{ID: template.ID, SeriesID: series, Recurrence: "custom"}); err != nil {
				s.internal(w, "ucb sync: set series", err)
				return
			}
		}
		for day, sl := range days {
			if day < today {
				continue // history isn't ours to rewrite
			}
			if ev, exists := haveDay[day]; exists {
				if ev.Status == "scheduled" && ev.StartsAt.Valid && !ev.StartsAt.Time.Equal(sl.at) {
					if err := s.queries.RetimeEvent(r.Context(), db.RetimeEventParams{ID: ev.ID, StartsAt: pgtype.Timestamptz{Time: sl.at, Valid: true}}); err != nil {
						s.internal(w, "ucb sync: retime", err)
						return
					}
					retimed++
				}
				continue
			}
			addr := template.LocationAddress
			if sl.venue != "" {
				addr = sl.venue
			}
			sib, cerr := s.queries.CreateEvent(r.Context(), db.CreateEventParams{
				HostID: ucbBotID, Title: template.Title, EventType: template.EventType, Description: template.Description,
				LocationMode: template.LocationMode, LocationAddress: addr,
				SchedulingMode: "fixed", StartsAt: pgtype.Timestamptz{Time: sl.at, Valid: true}, Status: "scheduled",
				GroupID: template.GroupID, SeriesID: series, Recurrence: "custom",
				Visibility: template.Visibility, Topic: template.Topic, City: template.City,
				CustomEmoji: template.CustomEmoji, CustomLabel: template.CustomLabel,
				GeneralScope: template.GeneralScope, Timezone: "America/Los_Angeles",
			})
			if cerr != nil {
				s.internal(w, "ucb sync: create occurrence", cerr)
				return
			}
			if template.PhotoUrl != "" || template.Theme != "" {
				_ = s.queries.SetEventLook(r.Context(), db.SetEventLookParams{ID: sib.ID, PhotoUrl: template.PhotoUrl, Theme: template.Theme})
			}
			created++
		}
		// Cancel: future scheduled occurrences the venue no longer lists,
		// but only inside the window the scrape actually observed.
		for day, ev := range haveDay {
			if _, listed := days[day]; listed || day <= today || day < minDay || day > maxDay {
				continue
			}
			if ev.Status != "scheduled" || ev.HostID != ucbBotID {
				continue
			}
			if err := s.queries.CancelEventQuiet(r.Context(), ev.ID); err != nil {
				s.internal(w, "ucb sync: cancel", err)
				return
			}
			cancelled++
		}
	}

	s.analytics.Capture(ucbBotID, "ucb_sync_ran", map[string]any{
		"group_id": in.GroupID, "shows": len(in.Shows),
		"adopted": adopted, "created": created, "retimed": retimed, "cancelled": cancelled,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"adopted": adopted, "created": created, "retimed": retimed, "cancelled": cancelled,
		"unmatched_titles": unmatched,
	})
}
