package main

// rozcossync.go - keeps Rozco's Comedy Club's weekly "Eastside Open Mic" series
// in a group current with the venue's real schedule. Rozco's sells every open-mic
// occurrence as its own ticketed event on SimpleTix, and - crucially - SimpleTix
// server-renders a clean JSON-LD Event block (with @type/name/startDate) on each
// event page for SEO. So there is NO headed browser here (a plain server-side GET
// returns the real content), but this is still HTML/JSON-LD SCRAPING, not a clean
// first-party API - so autoCreate is OFF, exactly like UCB: only titles the group
// ALREADY has are maintained (seed one "Eastside Open Mic" occurrence to start
// tracking it). This is the difference between Rozco's and the Squarespace/
// crowdwork venues (WGIS/We Improv/Buzz Mill), whose clean first-party JSON feeds
// earn autoCreate:true.
//
//   POST /api/cron/rozcos-sync   (CRON_KEY-gated)
//   {"group_id": "..."}          (no shows body; the server fetches + parses)
//
// Fetch shape: GET the org listing (rozcoscomedyclub.simpletix.com) -> extract
// every "eastside-open-mic" event URL (the listing is Rozco's WHOLE catalog -
// hundreds of produced shows too, so the "eastside open mic" title is the filter,
// the same empirical-title approach as We Improv/Buzz Mill) -> for the ones whose
// M/D slug plausibly falls in the forward window, GET the detail page and read
// the authoritative startDate from its JSON-LD. Every SimpleTix title is prefixed
// with the occurrence's "M/D" ("7/29 Eastside Open Mic"), which would give each
// date a DIFFERENT seriesKey - so the per-occurrence title is normalized to the
// canonical series title before bucketing (all occurrences collapse to one
// series that matches a seeded "Eastside Open Mic").
//
// ROZCOS_MODE=stub serves a fixed in-memory feed (network-free) for hermetic E2E.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	rozcosBotID     = "rozcos-bot"
	rozcosBotName   = "Rozco's Schedule"
	rozcosBotHandle = "rozcos-schedule-bot"
	rozcosListURL   = "https://rozcoscomedyclub.simpletix.com/"
	// The canonical series title. SimpleTix decorates each occurrence's title with
	// its "M/D" date; we collapse them all onto this so they form ONE series (and
	// match a seeded "Eastside Open Mic" event).
	rozcosSeriesTitle = "Eastside Open Mic"
	// The feed's location is just "Rozco's Comedy Club"; this is the real place.
	rozcosAddress = "1805 E 7th St, Austin, TX 78702"
	// How far ahead we sync, and a cap on detail fetches so a listing bloated with
	// archived occurrences can never fan out into an unbounded number of requests.
	rozcosWindowDays = 185
	rozcosMaxFetch   = 40
)

// rozcosSlot is one open-mic occurrence resolved from a SimpleTix detail page.
type rozcosSlot struct {
	at    time.Time
	venue string
}

var (
	// Event links on the listing that are Eastside Open Mic occurrences.
	rozcosLinkRe = regexp.MustCompile(`href="(https://www\.simpletix\.com/e/[^"]*eastside-open-mic[^"]*)"`)
	// The "M-D" prefix in an event slug (/e/7-29-eastside-open-mic-...), used only
	// to pre-filter which detail pages are worth fetching; the JSON-LD startDate is
	// the authority for the actual day+time.
	rozcosSlugMDRe = regexp.MustCompile(`/e/(\d{1,2})-(\d{1,2})-eastside-open-mic`)
	// The "M/D " prefix on a SimpleTix event NAME ("7/29 Eastside Open Mic").
	rozcosNamePrefixRe = regexp.MustCompile(`^\s*\d{1,2}/\d{1,2}\s+`)
	ldBlockRe          = regexp.MustCompile(`(?is)<script type="application/ld\+json">(.*?)</script>`)
)

// ldEvent is the minimal schema.org Event we read from a SimpleTix detail page.
type ldEvent struct {
	Type      string `json:"@type"`
	Name      string `json:"name"`
	StartDate string `json:"startDate"` // RFC3339 (SimpleTix emits UTC, +00:00)
}

func (s *server) handleCronRozcosSync(w http.ResponseWriter, r *http.Request) {
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
		s.internal(w, "rozcos sync: tz", err)
		return
	}

	slots, err := s.fetchRozcosOpenMics(r.Context(), loc)
	if err != nil {
		s.internal(w, "rozcos sync: fetch", err)
		return
	}

	// One title (Eastside Open Mic) -> one series; bucket by Central calendar day.
	series := map[string]venueSeries{}
	for _, sl := range slots {
		k := seriesKey(rozcosSeriesTitle)
		vs, ok := series[k]
		if !ok {
			vs = venueSeries{title: rozcosSeriesTitle, eventType: "openmic", days: map[string]venueSlot{}}
		}
		vs.days[sl.at.In(loc).Format("2006-01-02")] = venueSlot{at: sl.at.In(loc), venue: sl.venue}
		series[k] = vs
	}
	if len(series) == 0 {
		writeJSON(w, http.StatusOK, venueSyncStats{}) // nothing upcoming - fine
		return
	}

	st, err := s.syncVenueSeries(r.Context(), gid, series, venueSyncOpts{
		botID: rozcosBotID, botName: rozcosBotName, botHandle: rozcosBotHandle, autoCreate: false, loc: loc,
	})
	if err != nil {
		s.internal(w, "rozcos sync", err)
		return
	}
	s.analytics.Capture(rozcosBotID, "rozcos_sync_ran", map[string]any{
		"group_id": in.GroupID, "occurrences": len(slots),
		"adopted": st.Adopted, "created": st.Created, "retimed": st.Retimed, "cancelled": st.Cancelled,
	})
	writeJSON(w, http.StatusOK, st)
}

// fetchRozcosOpenMics returns the upcoming Eastside Open Mic occurrences (or a
// fixed stub under ROZCOS_MODE=stub). It fetches the org listing, extracts the
// open-mic event URLs, pre-filters by the slug's M/D to the forward window (so a
// listing full of archived occurrences doesn't fan into hundreds of requests),
// then reads each detail page's JSON-LD startDate as the source of truth.
func (s *server) fetchRozcosOpenMics(ctx context.Context, loc *time.Location) ([]rozcosSlot, error) {
	if s.rozcosStub {
		return stubRozcosOpenMics(loc), nil
	}

	listing, err := s.httpGetString(ctx, rozcosListURL, 1<<20)
	if err != nil {
		return nil, err
	}
	now := time.Now().In(loc)

	// Dedupe URLs, keep only those whose M/D plausibly lands in the window.
	seen := map[string]bool{}
	var urls []string
	for _, m := range rozcosLinkRe.FindAllStringSubmatch(listing, -1) {
		u := m[1]
		if seen[u] {
			continue
		}
		seen[u] = true
		md := rozcosSlugMDRe.FindStringSubmatch(u)
		if md == nil {
			continue // no dated prefix (generic/archived listing) - skip
		}
		mo, _ := strconv.Atoi(md[1])
		day, _ := strconv.Atoi(md[2])
		if !rozcosMDInWindow(mo, day, now, loc) {
			continue
		}
		urls = append(urls, u)
		if len(urls) >= rozcosMaxFetch {
			break
		}
	}

	var out []rozcosSlot
	for _, u := range urls {
		page, perr := s.httpGetString(ctx, u, 512<<10)
		if perr != nil {
			continue // one bad detail page shouldn't sink the whole run
		}
		ev, ok := firstLDEvent(page)
		if !ok {
			continue
		}
		// Only genuine open-mic titles (the URL filter already narrows this; this
		// guards against SimpleTix slug reuse for a non-open-mic show).
		if !strings.Contains(strings.ToLower(ev.Name), "open mic") {
			continue
		}
		at, terr := time.Parse(time.RFC3339, ev.StartDate)
		if terr != nil {
			continue
		}
		at = at.In(loc)
		if at.Before(now.AddDate(0, 0, -1)) || at.After(now.AddDate(0, 0, rozcosWindowDays)) {
			continue
		}
		out = append(out, rozcosSlot{at: at, venue: rozcosAddress})
	}
	return out, nil
}

// httpGetString fetches a URL through the SSRF-guarded client and returns the
// body as a string, capped at max bytes.
func (s *server) httpGetString(ctx context.Context, url string, max int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	// A browser-ish UA - some hosts serve a stripped page to unknown agents.
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; WhensdaysBot/1.0; +https://whensdays.com)")
	resp, err := safeHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, max))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// firstLDEvent returns the first schema.org Event (with a startDate) found in any
// ld+json block on the page. Handles both a bare object and a top-level array.
func firstLDEvent(html string) (ldEvent, bool) {
	for _, m := range ldBlockRe.FindAllStringSubmatch(html, -1) {
		raw := strings.TrimSpace(m[1])
		var one ldEvent
		if json.Unmarshal([]byte(raw), &one) == nil && one.Type == "Event" && one.StartDate != "" {
			return one, true
		}
		var arr []ldEvent
		if json.Unmarshal([]byte(raw), &arr) == nil {
			for _, e := range arr {
				if e.Type == "Event" && e.StartDate != "" {
					return e, true
				}
			}
		}
	}
	return ldEvent{}, false
}

// rozcosMDInWindow reports whether an "M/D" (year-less) occurrence plausibly
// falls in [now-3d, now+window]. It's only a coarse pre-filter to bound detail
// fetches - the JSON-LD startDate is the authority - so it errs toward including.
func rozcosMDInWindow(month, day int, now time.Time, loc *time.Location) bool {
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return false
	}
	cand := time.Date(now.Year(), time.Month(month), day, 12, 0, 0, 0, loc)
	if cand.Before(now.AddDate(0, 0, -3)) {
		cand = time.Date(now.Year()+1, time.Month(month), day, 12, 0, 0, 0, loc)
	}
	return cand.Before(now.AddDate(0, 0, rozcosWindowDays+3))
}

// stubRozcosOpenMics: fixed, network-free feed for ROZCOS_MODE=stub (hermetic
// E2E). Three occurrences of the one Eastside Open Mic series, starting at the
// same +2d date the E2E test seeds, so with autoCreate OFF the sync ADOPTS the
// seeded occurrence and ADDS the two later siblings (created=2, adopted=1),
// mirroring the UCB test. Dates are built from an explicit RFC3339 string with
// the Central offset (mirrors Buzz Mill's stub) rather than truncating an
// absolute instant to 24h - that rounds to UTC midnight, not Central midnight,
// silently shifting the calendar date whenever the run straddles the UTC/Central
// date boundary.
func stubRozcosOpenMics(loc *time.Location) []rozcosSlot {
	base := time.Now().In(time.FixedZone("CT", -5*3600))
	at := func(days int) time.Time {
		iso := base.AddDate(0, 0, days).Format("2006-01-02") + "T20:00:00-05:00"
		t, err := time.Parse(time.RFC3339, iso)
		if err != nil {
			panic(err) // stub-only, fixed format - a parse failure means the format string is wrong
		}
		return t.In(loc)
	}
	return []rozcosSlot{
		{at: at(2), venue: rozcosAddress},
		{at: at(9), venue: rozcosAddress},
		{at: at(16), venue: rozcosAddress},
	}
}
