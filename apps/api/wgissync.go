package main

// wgissync.go - keeps the WGIS (World's Greatest Improv School) jam series in
// the group current with the venue's real schedule. Unlike UCB, WGIS exposes a
// clean JSON feed (crowdwork.com), so there is NO scraper and NO browser: the
// app fetches + parses the feed server-side and drives the shared engine
// (venuesync.go). autoCreate is ON - a curated jam feed from one theatre, so a
// missing jam becomes a new series from the feed (no manual seeding), and its
// poster is pulled in as the cover.
//
//   POST /api/cron/wgis-sync   (CRON_KEY-gated)
//   {"group_id": "..."}        (no shows body; the server fetches the feed)
//
// WGIS_MODE=stub serves a fixed in-memory feed (network-free) for hermetic E2E.

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
)

const (
	wgisBotID     = "wgis-bot"
	wgisBotName   = "WGIS Schedule"
	wgisBotHandle = "wgis-schedule-bot"
	wgisFeedURL   = "https://crowdwork.com/api/v2/wgis/shows"
	// The feed's `venue` is just a name ("WGIS Space"); this is the real place.
	wgisAddress = "1615 N Vermont Ave, Los Feliz, CA 90027"
)

// crowdwork /api/v2/{theatre}/shows response (only the fields we use).
type crowdworkShow struct {
	Name             string   `json:"name"`
	Status           string   `json:"status"`
	Dates            []string `json:"dates"` // RFC3339 with tz offset
	DescriptionShort string   `json:"description_short"`
	Img              struct {
		Large string `json:"large"`
	} `json:"img"`
}

func (s *server) handleCronWGISSync(w http.ResponseWriter, r *http.Request) {
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
		s.internal(w, "wgis sync: tz", err)
		return
	}

	shows, err := s.fetchWGISShows(r.Context())
	if err != nil {
		s.internal(w, "wgis sync: fetch feed", err)
		return
	}

	// Keep only active JAMS; bucket by series key, then LA calendar day.
	series := map[string]venueSeries{}
	for _, sh := range shows {
		if sh.Status != "active" || !strings.Contains(strings.ToLower(sh.Name), "jam") {
			continue
		}
		k := seriesKey(sh.Name)
		vs, ok := series[k]
		if !ok {
			vs = venueSeries{
				title:       sh.Name,
				eventType:   "openmic", // a jam = open participation
				description: htmlToText(sh.DescriptionShort),
				coverURL:    sh.Img.Large,
				days:        map[string]venueSlot{},
			}
		}
		for _, iso := range sh.Dates {
			t, terr := time.Parse(time.RFC3339, iso)
			if terr != nil {
				continue
			}
			at := t.In(loc)
			vs.days[at.Format("2006-01-02")] = venueSlot{at: at, venue: wgisAddress}
		}
		series[k] = vs
	}
	if len(series) == 0 {
		writeJSON(w, http.StatusOK, venueSyncStats{}) // feed had no jams - fine
		return
	}

	st, err := s.syncVenueSeries(r.Context(), gid, series, venueSyncOpts{
		botID: wgisBotID, botName: wgisBotName, botHandle: wgisBotHandle, autoCreate: true, loc: loc,
	})
	if err != nil {
		s.internal(w, "wgis sync", err)
		return
	}
	s.analytics.Capture(wgisBotID, "wgis_sync_ran", map[string]any{
		"group_id": in.GroupID, "series": len(series),
		"adopted": st.Adopted, "created": st.Created, "retimed": st.Retimed, "cancelled": st.Cancelled,
	})
	writeJSON(w, http.StatusOK, st)
}

// fetchWGISShows returns the crowdwork feed (or a fixed stub under WGIS_MODE=stub).
func (s *server) fetchWGISShows(ctx context.Context) ([]crowdworkShow, error) {
	if s.wgisStub {
		return stubWGISShows(), nil
	}
	// A ±150-day window covers the venue's whole upcoming schedule.
	now := time.Now()
	u := wgisFeedURL + "?start=" + now.AddDate(0, 0, -1).Format("2006-01-02") + "&end=" + now.AddDate(0, 0, 150).Format("2006-01-02")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := safeHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var out struct {
		Data []crowdworkShow `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

// fetchPosterCover pulls a remote poster, downscales it, and returns a JPEG
// data URL suitable for an event cover (validCoverURL accepts data:image/).
// Any failure returns "" - the event stays title-led. SSRF-guarded like every
// outbound fetch; the stub path is network-free.
func (s *server) fetchPosterCover(ctx context.Context, url string) string {
	if s.wgisStub {
		return encodeCover(image.NewRGBA(image.Rect(0, 0, 8, 8))) // deterministic tiny JPEG
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	resp, err := safeHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 12<<20))
	if err != nil {
		return ""
	}
	img := safeDecode(body) // dimension-guarded (pixel-bomb safe)
	if img == nil {
		return ""
	}
	return encodeCover(img)
}

// encodeCover downscales an image to <=640px wide and returns a JPEG data URL
// under the server's cover-body cap (validCoverURL / coverMaxBody), stepping
// quality down as needed. "" if it can't be made to fit.
func encodeCover(src image.Image) string {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return ""
	}
	const maxW = 640
	if w > maxW {
		h = h * maxW / w
		w = maxW
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	// base64 inflates ~4/3, and the data URL length is what gets capped.
	rawCap := coverMaxBody*3/4 - 64
	for _, q := range []int{85, 72, 58, 45} {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: q}); err != nil {
			return ""
		}
		if buf.Len() <= rawCap || q == 45 {
			if buf.Len() > rawCap {
				return "" // still too big even at the floor quality
			}
			return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
		}
	}
	return ""
}

var htmlTag = regexp.MustCompile(`<[^>]*>`)

// htmlToText strips tags + common entities from a feed description and caps it
// at the server's details field limit (2000). Block tags become line breaks so
// paragraphs survive as newlines.
func htmlToText(s string) string {
	s = strings.NewReplacer("</p>", "\n", "</div>", "\n", "<br>", "\n", "<br/>", "\n", "<br />", "\n").Replace(s)
	s = htmlTag.ReplaceAllString(s, "")
	s = strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&nbsp;", " ").Replace(s)
	// Collapse runs of blank lines / trailing spaces.
	lines := strings.Split(s, "\n")
	var out []string
	for _, ln := range lines {
		out = append(out, strings.TrimSpace(ln))
	}
	s = strings.TrimSpace(strings.Join(out, "\n"))
	for strings.Contains(s, "\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n", "\n\n")
	}
	if len(s) > 2000 {
		s = s[:2000]
	}
	return s
}

// stubWGISShows: fixed, network-free feed for WGIS_MODE=stub (hermetic E2E).
// Two jams so the engine's auto-create + fan-out are exercised deterministically.
func stubWGISShows() []crowdworkShow {
	// Anchor on a fixed base so the test can predict dates; dev mode is exempt
	// from the past-date guard, and the sync skips days before "today" anyway,
	// so use dates comfortably in the future relative to any test run.
	base := time.Now().In(time.FixedZone("PT", -7*3600))
	d := func(days int) string { return base.AddDate(0, 0, days).Format("2006-01-02") + "T18:00:00.000-07:00" }
	sauce := crowdworkShow{
		Name: "The Sauce Jam", Status: "active",
		DescriptionShort: "<div>Come improv jam with The Sauce! All levels welcome.</div>",
		Dates:            []string{d(3), d(10), d(17)},
	}
	sauce.Img.Large = "stub://poster" // non-empty so the cover path runs (fetch is stubbed)
	queer := crowdworkShow{
		Name: "Queer Jam", Status: "active",
		DescriptionShort: "The Queer Jam at WGIS &mdash; every 2nd &amp; 4th Wednesday.",
		Dates:            []string{d(5), d(19)},
	}
	queer.Img.Large = "stub://poster"
	return []crowdworkShow{sauce, queer}
}
