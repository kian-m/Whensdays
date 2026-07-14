package main

import (
	"net/http"
	"sync"
	"time"
)

// Landing-page live proof: how many plans have locked in a time. Unauthenticated
// (it renders for signed-out strangers) and rate-limited like the other public
// reads; the count is cached in-process for 10 minutes because the landing page
// is the most bot-hit URL on the site and this must never become a DB tap.
// `show` gates the number server-side - an early-days count is worse social
// proof than none, so the web renders nothing until it clears the bar.
const landingProofMin = 50

var landingStats struct {
	sync.Mutex
	n       int64
	fetched time.Time
}

func (s *server) handleLandingStats(w http.ResponseWriter, r *http.Request) {
	landingStats.Lock()
	defer landingStats.Unlock()
	if time.Since(landingStats.fetched) > 10*time.Minute {
		if n, err := s.queries.CountScheduledEvents(r.Context()); err == nil {
			landingStats.n = n
			landingStats.fetched = time.Now()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"plans_locked": landingStats.n,
		"show":         landingStats.n >= landingProofMin,
	})
}
