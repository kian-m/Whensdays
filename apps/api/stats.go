package main

import "net/http"

// stats.go - one public, unauthenticated, read-only counter for marketing
// surfaces (currently the static apps/web/public/free-scheduler/index.html
// page's "N events scheduled so far" line, the any1.free-style social proof).
// Same trust tier as GET /api/discover: no PII, rate-limited like every other
// unauthenticated route (readLimit in main.go), off under AUTH_MODE=dev like
// the other IP limiters.

// handlePublicStats: GET /api/public/stats.
func (s *server) handlePublicStats(w http.ResponseWriter, r *http.Request) {
	n, err := s.queries.CountScheduledEvents(r.Context())
	if err != nil {
		s.internal(w, "public stats", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int32{"events_scheduled": n})
}
