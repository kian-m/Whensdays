package main

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/clsandbox/api/internal/db"
)

// discover.go — Phase 2 (public discovery) + the P2 reminder cron.
//
// Public events are browsable by ANYONE (GET /api/discover is unauthenticated
// and read-only: it exposes only what the host chose to publish — title, type,
// time, topic, city, host name). Follows (host or topic) build a personal feed.
// Reminders: a once-daily 2pm-Pacific scheduler hits the key-gated cron
// endpoint; each event happening the next Pacific calendar day is reminded once.

// topicRe: topics are lowercase slugs, e.g. "twitch", "board-games".
var topicRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,29}$`)

// ---------------------- reminders (cron) ----------------------

// handleCronReminders is unauthenticated but gated by CRON_KEY (constant-time
// compare). Designed for Cloud Scheduler; idempotent via reminder_sent.
func (s *server) handleCronReminders(w http.ResponseWriter, r *http.Request) {
	key := os.Getenv("CRON_KEY")
	if key == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Cron-Key")), []byte(key)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	events, err := s.queries.ListEventsNeedingReminder(r.Context())
	if err != nil {
		s.internal(w, "list reminders", err)
		return
	}
	sent := 0
	for _, ev := range events {
		if s.notifyReminder(r.Context(), ev) > 0 {
			sent++
		}
		if err := s.queries.MarkEventReminded(r.Context(), ev.ID); err != nil {
			s.internal(w, "mark reminded", err)
			return
		}
	}
	s.analytics.CaptureServer("reminders_run", map[string]any{"events": len(events), "emailed": sent})
	writeJSON(w, http.StatusOK, map[string]int{"events": len(events), "emailed": sent})
}

// ---------------------- public discovery ----------------------

// handleDiscover is public by design (no auth): browse upcoming public events,
// optionally filtered by ?topic= and ?city=. No viewer → no annotations.
func (s *server) handleDiscover(w http.ResponseWriter, r *http.Request) {
	s.discoverFor(w, r, "")
}

// handleDiscoverMine is the authed twin: same browse, plus per-viewer
// annotations (friends going, your RSVP, friend-hosted) for tile styling.
func (s *server) handleDiscoverMine(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	s.discoverFor(w, r, uid)
}

func (s *server) discoverFor(w http.ResponseWriter, r *http.Request, viewer string) {
	topic := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("topic")))
	if topic != "" && !topicRe.MatchString(topic) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid topic"})
		return
	}
	city := strings.TrimSpace(r.URL.Query().Get("city"))
	if len(city) > 60 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid city"})
		return
	}
	events, err := s.queries.ListPublicEvents(r.Context(), db.ListPublicEventsParams{Column1: topic, Column2: expandCityFilter(city), Column3: viewer})
	if err != nil {
		s.internal(w, "discover", err)
		return
	}
	// Category chips render only for topics with something to show.
	topics, err := s.queries.ListActiveTopics(r.Context())
	if err != nil {
		s.internal(w, "active topics", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "topics": topics})
}

// handleFeed returns the ranked "For you" feed (auth required): every upcoming
// public event, scored by the algorithm in ranking.go. Cold start degrades
// gracefully to time-proximity + popularity.
func (s *server) handleFeed(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	// ?scope=friends → upcoming events your accepted friends are hosting
	// (friends- or public-visible); default scope is all public events.
	var candidates []db.ListPublicEventsRow
	var err error
	if r.URL.Query().Get("scope") == "friends" {
		rows, ferr := s.queries.ListFriendsEvents(r.Context(), uid)
		err = ferr
		for _, x := range rows {
			candidates = append(candidates, db.ListPublicEventsRow(x))
		}
	} else {
		candidates, err = s.queries.ListPublicEvents(r.Context(), db.ListPublicEventsParams{Column1: "", Column2: []string{}, Column3: uid})
	}
	if err != nil {
		s.internal(w, "feed candidates", err)
		return
	}
	follows, err := s.queries.ListFollows(r.Context(), uid)
	if err != nil {
		s.internal(w, "list follows", err)
		return
	}

	sig := feedSignals{
		FollowedHosts: map[string]bool{}, FollowedTopics: map[string]bool{},
		HostPrior: map[string]int{}, TopicPrior: map[string]int{}, TypePrior: map[string]int{},
		FriendGoing: map[string]int{}, Going: map[string]int{}, Now: time.Now(),
	}
	for _, f := range follows {
		if f.Kind == "host" {
			sig.FollowedHosts[f.Value] = true
		} else {
			sig.FollowedTopics[f.Value] = true
		}
	}
	// Taste from the user's own RSVP history. Best-effort: a signal failing to
	// load should never take the feed down.
	if hist, err := s.queries.ListUserRsvpHistory(r.Context(), uid); err == nil {
		for _, h := range hist {
			sig.HostPrior[h.HostID]++
			if h.Topic != "" {
				sig.TopicPrior[h.Topic]++
			}
			sig.TypePrior[h.EventType]++
		}
	}
	if counts, err := s.queries.CountGoingForPublicUpcoming(r.Context()); err == nil {
		for _, c := range counts {
			sig.Going[uuidStr(c.EventID)] = int(c.Going)
		}
	}
	if friends, err := s.queries.ListFriendIDs(r.Context(), uid); err == nil && len(friends) > 0 {
		if counts, err := s.queries.CountFriendGoingForPublicUpcoming(r.Context(), friends); err == nil {
			for _, c := range counts {
				sig.FriendGoing[uuidStr(c.EventID)] = int(c.Going)
			}
		}
	}

	ranked := rankEvents(candidates, sig)
	if len(ranked) > 50 {
		ranked = ranked[:50]
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": ranked, "follows": follows})
}

func (s *server) handleAddFollow(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Kind  string `json:"kind"`
		Value string `json:"value"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Value = strings.TrimSpace(in.Value)
	if !oneOf(in.Kind, "host", "topic") || in.Value == "" || len(in.Value) > 100 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "kind must be host/topic with a value"})
		return
	}
	if in.Kind == "topic" && !topicRe.MatchString(in.Value) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid topic"})
		return
	}
	if in.Kind == "host" && in.Value == uid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "you can't follow yourself"})
		return
	}
	if err := s.queries.AddFollow(r.Context(), db.AddFollowParams{UserID: uid, Kind: in.Kind, Value: in.Value}); err != nil {
		s.internal(w, "add follow", err)
		return
	}
	s.analytics.Capture(uid, "followed", map[string]any{"kind": in.Kind})
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

func (s *server) handleRemoveFollow(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	kind, value := r.PathValue("kind"), r.PathValue("value")
	if !oneOf(kind, "host", "topic") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad kind"})
		return
	}
	if err := s.queries.RemoveFollow(r.Context(), db.RemoveFollowParams{UserID: uid, Kind: kind, Value: value}); err != nil {
		s.internal(w, "remove follow", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// validatePublicFields checks visibility/topic/city on event creation. Topics
// are a FIXED category set (ranking.go) — never free text.
func validatePublicFields(visibility, topic, city string) error {
	if visibility != "" && !oneOf(visibility, "private", "friends", "public") {
		return fmt.Errorf("invalid visibility")
	}
	if topic != "" && !validCategory(topic) {
		return fmt.Errorf("topic must be one of the preset categories")
	}
	if len(city) > 60 {
		return fmt.Errorf("city too long")
	}
	return nil
}
