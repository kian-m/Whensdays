package main

import (
	"encoding/json"
	"io"
	"net/http"
)

// csp.go - collector for Content-Security-Policy-Report-Only violations. The
// web origin (Cloudflare Pages, _headers) sends CSP reports here; we log each
// blocked directive + resource so the enforcing allowlist can be built from
// REAL production traffic (Clerk/PostHog load scripts dynamically, so the gaps
// only show under a signed-in browser). Unauthenticated + rate-limited: it's a
// browser-driven beacon. No body is trusted beyond logging.
func (s *server) handleCSPReport(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	// Two wire formats: legacy {"csp-report": {...}} and the Reporting API array.
	var legacy struct {
		Report struct {
			DocumentURI        string `json:"document-uri"`
			ViolatedDirective  string `json:"violated-directive"`
			EffectiveDirective string `json:"effective-directive"`
			BlockedURI         string `json:"blocked-uri"`
		} `json:"csp-report"`
	}
	if json.Unmarshal(body, &legacy) == nil && legacy.Report.BlockedURI != "" {
		dir := legacy.Report.EffectiveDirective
		if dir == "" {
			dir = legacy.Report.ViolatedDirective
		}
		s.logger.Warn("csp_violation", "directive", dir, "blocked", legacy.Report.BlockedURI, "doc", legacy.Report.DocumentURI)
	}
	w.WriteHeader(http.StatusNoContent)
}
