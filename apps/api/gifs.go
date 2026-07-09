package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// gifs.go - a thin authenticated proxy over the Klipy GIF search API, used to
// pick an event cover. The API key stays server-side (KLIPY_API_KEY env, never
// shipped to the browser or the repo); when unset the endpoint reports
// enabled=false and the web hides the GIF picker. Klipy is Tenor-compatible:
// GET https://api.klipy.com/v2/search?key=…&q=…

const coverMaxBody = 256 << 10 // event covers ride as ~420px JPEG data URLs

// eventThemes are the preset backdrop slugs an event page can adopt.
var eventThemes = []string{"", "party", "beach", "forest", "night", "neon", "cozy"}

func validEventTheme(t string) bool { return oneOf(t, eventThemes...) }

// validCoverURL accepts an uploaded image (data URL) or a Klipy CDN asset -
// never an arbitrary remote URL (no hotlink/SSRF surface).
func validCoverURL(u string) bool {
	if u == "" {
		return true
	}
	if strings.HasPrefix(u, "data:image/") {
		return len(u) <= coverMaxBody
	}
	return strings.HasPrefix(u, "https://static.klipy.com/") && len(u) <= 500
}

// validGifURL: comment/cover gifs may only come from the Klipy CDN (or the
// stub sentinel in KLIPY_MODE=stub test stacks) - never arbitrary remotes.
func validGifURL(u string) bool {
	if u == "" {
		return true
	}
	return (strings.HasPrefix(u, "https://static.klipy.com/") || strings.HasPrefix(u, "/gif-stub/")) && len(u) <= 500
}

// stubGifs mirrors CALENDAR_MODE=stub: fixed, network-free results so E2E and
// docs stacks can exercise the picker without a key. Never enable in prod.
var stubGifs = []map[string]string{
	{"url": "/gif-stub/party-1.gif", "preview": "/gif-stub/party-1.gif", "title": "Stub party"},
	{"url": "/gif-stub/party-2.gif", "preview": "/gif-stub/party-2.gif", "title": "Stub confetti"},
}

// handleGifSearch proxies Klipy. An empty q returns trending (so the picker is
// never blank on open); a non-empty q searches. Paging rides on Klipy's `next`
// cursor (passed back as `pos`), so the web can lazily load more pages.
func (s *server) handleGifSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pos := strings.TrimSpace(r.URL.Query().Get("pos"))

	if s.klipyStub {
		// Two fixed pages so E2E/docs can exercise search + "load more".
		if pos == "" {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "gifs": stubGifs, "next": "p2"})
		} else {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "gifs": stubGifs, "next": ""})
		}
		return
	}
	if s.klipyKey == "" {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "gifs": []any{}})
		return
	}
	if len(q) > 100 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "q too long"})
		return
	}

	base := "https://api.klipy.com/v2/featured?key=" + url.QueryEscape(s.klipyKey) + "&limit=24&media_filter=gif,tinygif"
	if q != "" {
		base = "https://api.klipy.com/v2/search?key=" + url.QueryEscape(s.klipyKey) +
			"&q=" + url.QueryEscape(q) + "&limit=24&media_filter=gif,tinygif"
	}
	if pos != "" {
		base += "&pos=" + url.QueryEscape(pos)
	}

	resp, err := safeHTTPClient(6 * time.Second).Get(base)
	if err != nil {
		s.internal(w, "klipy fetch", err)
		return
	}
	defer resp.Body.Close()
	var body struct {
		Results []struct {
			Title        string `json:"title"`
			MediaFormats map[string]struct {
				URL string `json:"url"`
			} `json:"media_formats"`
		} `json:"results"`
		Next string `json:"next"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		s.internal(w, "klipy decode", err)
		return
	}
	type gif struct {
		URL     string `json:"url"`
		Preview string `json:"preview"`
		Title   string `json:"title"`
	}
	gifs := make([]gif, 0, len(body.Results))
	for _, g := range body.Results {
		full, small := g.MediaFormats["gif"].URL, g.MediaFormats["tinygif"].URL
		if small == "" {
			small = full
		}
		// Only pass through the CDN host the cover validator accepts.
		if full == "" || !strings.HasPrefix(full, "https://static.klipy.com/") {
			continue
		}
		gifs = append(gifs, gif{URL: full, Preview: small, Title: g.Title})
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "gifs": gifs, "next": body.Next})
}
