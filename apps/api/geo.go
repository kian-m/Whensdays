package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// geo.go — address type-ahead for the event location field. Proxies Photon
// (photon.komoot.io, OpenStreetMap-based): free, keyless, no billing. Server-
// side so the browser stays single-origin, the upstream host is fixed (no
// SSRF), and we can bound/normalize the response. Best-effort — any upstream
// failure returns an empty result, not an error, so the field stays usable.

// geoStub mirrors CALENDAR_MODE=stub / KLIPY_MODE=stub: fixed, network-free
// suggestions so E2E/docs stacks exercise the type-ahead without the network.
var geoStub = []map[string]string{
	{"label": "123 Main St, Brooklyn, NY 11201"},
	{"label": "123 Main St, Brookline, MA 02445"},
}

func (s *server) handleGeoSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 3 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	if len(q) > 120 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "query too long"})
		return
	}
	if s.geoStub {
		writeJSON(w, http.StatusOK, map[string]any{"results": geoStub})
		return
	}

	u := "https://photon.komoot.io/api?limit=5&q=" + url.QueryEscape(q)
	client := &http.Client{Timeout: 4 * time.Second}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Whensdays/1.0 (event scheduler)")
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	defer resp.Body.Close()

	// Photon returns GeoJSON: features[].properties {name, housenumber, street,
	// city, state, postcode, country}. Collapse each into a single label.
	var body struct {
		Features []struct {
			Properties struct {
				Name        string `json:"name"`
				HouseNumber string `json:"housenumber"`
				Street      string `json:"street"`
				City        string `json:"city"`
				State       string `json:"state"`
				Postcode    string `json:"postcode"`
				Country     string `json:"country"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	results := make([]map[string]string, 0, len(body.Features))
	seen := map[string]bool{}
	for _, f := range body.Features {
		label := geoLabel(f.Properties.Name, f.Properties.HouseNumber, f.Properties.Street,
			f.Properties.City, f.Properties.State, f.Properties.Postcode, f.Properties.Country)
		if label == "" || seen[label] {
			continue
		}
		seen[label] = true
		results = append(results, map[string]string{"label": label})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// geoLabel joins address parts into "street line, city, state postcode, country".
func geoLabel(name, house, street, city, state, postcode, country string) string {
	line1 := strings.TrimSpace(strings.TrimSpace(house + " " + street))
	if line1 == "" {
		line1 = name
	}
	parts := []string{}
	if line1 != "" {
		parts = append(parts, line1)
	}
	if city != "" {
		parts = append(parts, city)
	}
	sp := strings.TrimSpace(state + " " + postcode)
	if sp != "" {
		parts = append(parts, sp)
	}
	if country != "" {
		parts = append(parts, country)
	}
	return strings.Join(parts, ", ")
}
