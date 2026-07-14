package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/clsandbox/api/internal/db"
)

// engage.go - the two "tighten the loop" levers from the roadmap:
//
//  1. One-tap RSVP from email. GET /api/events/{id}/rsvp-link?token=&r= is
//     UNauthenticated by necessity (mail clients send no bearer): identity and
//     scope ride in an HMAC token namespaced "rsvp|" (same envelope as guest/
//     mute tokens, so nothing cross-verifies). It records the RSVP and renders
//     a script-free confirmation page with a one-tap undo - a guest can say
//     yes without ever loading the app.
//
//  2. Host Nudge. POST /api/events/{id}/nudge re-emails ONLY invited people
//     who haven't responded at all (mute-filtered), with one-tap RSVP buttons.
//     Rate-limited to once per 24h per event so hosts can't spam.

func (g guestSigner) signRsvp(userID, eventID string) string {
	return hmacSeal(g.key, "rsvp|"+userID+"|"+eventID)
}

func (g guestSigner) verifyRsvp(token string) (userID, eventID string, ok bool) {
	payload, ok := hmacOpen(g.key, token)
	if !ok {
		return "", "", false
	}
	parts := strings.SplitN(string(payload), "|", 3)
	if len(parts) != 3 || parts[0] != "rsvp" {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// rsvpLink builds a one-tap email RSVP URL for a recipient. r is going|declined.
func (s *server) rsvpLink(userID, eventID, r string) string {
	if s.appOrigin == "" {
		return ""
	}
	return s.appOrigin + "/api/events/" + eventID + "/rsvp-link?token=" + s.guests.signRsvp(userID, eventID) + "&r=" + r
}

// handleEmailRsvp records an RSVP straight from an email button.
func (s *server) handleEmailRsvp(w http.ResponseWriter, r *http.Request) {
	pathID := r.PathValue("id")
	userID, eventID, ok := s.guests.verifyRsvp(r.URL.Query().Get("token"))
	if !ok || eventID != pathID {
		s.unsubPage(w, http.StatusForbidden, "This link isn't valid", "The RSVP link is invalid or malformed.", "", "")
		return
	}
	answer := r.URL.Query().Get("r")
	if !oneOf(answer, "going", "declined") {
		s.unsubPage(w, http.StatusBadRequest, "This link isn't valid", "Unknown RSVP choice.", "", "")
		return
	}
	id, ok := parseUUID(eventID)
	if !ok {
		s.unsubPage(w, http.StatusBadRequest, "This link isn't valid", "The event could not be found.", "", "")
		return
	}
	ev, err := s.queries.GetEvent(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		s.unsubPage(w, http.StatusNotFound, "Event not found", "This event no longer exists.", "", "")
		return
	}
	if err != nil || ev.Status == "cancelled" {
		s.unsubPage(w, http.StatusConflict, "This event was cancelled", "No RSVP needed - the host called it off.", s.eventURL(id), "")
		return
	}
	// Same change-detection as the in-app handler: no row back = unchanged.
	// Anonymous stays false on INSERT; a re-RSVP's conflict branch never touches
	// a stored anonymity choice (see the UpsertRsvp query comment).
	_, err = s.queries.UpsertRsvp(r.Context(), db.UpsertRsvpParams{EventID: id, UserID: userID, Rsvp: answer})
	changed := true
	if errors.Is(err, pgx.ErrNoRows) {
		changed, err = false, nil
	}
	if err != nil {
		s.unsubPage(w, http.StatusInternalServerError, "Something went wrong", "Please try again from the event page.", s.eventURL(id), "")
		return
	}
	s.analytics.Capture(userID, "rsvp_submitted", map[string]any{"event_id": eventID, "rsvp": answer, "via": "email"})
	if answer == "going" && changed && s.notify.Enabled() {
		if p, perr := s.queries.GetProfile(r.Context(), userID); perr == nil {
			s.notifyNewRSVP(r.Context(), ev, userID, p.DisplayName)
		}
	}
	other := "declined"
	title, msg := "You're in 🎉", `You're marked as going to "`+ev.Title+`".`
	if answer == "declined" {
		other = "going"
		title, msg = "Sorry you'll miss it", `You're marked as can't-go for "`+ev.Title+`".`
	}
	undo := s.rsvpLink(userID, eventID, other)
	s.unsubPage(w, http.StatusOK, title, msg, s.eventURL(id), undo)
}

// handleNudge re-invites everyone who hasn't responded. Manager-only, 1/day.
func (s *server) handleNudge(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "nudge: load event", err)
		return
	}
	if !isManager(role) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your event"})
		return
	}
	if ev.Status == "cancelled" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "event is cancelled"})
		return
	}
	if last, err := s.queries.GetNudgedAt(r.Context(), id); err == nil && time.Since(last.Time) < 24*time.Hour {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "already nudged today - try again tomorrow"})
		return
	}
	contacts, err := s.queries.ListInvitedNonResponderContacts(r.Context(), id)
	if err != nil {
		s.internal(w, "nudge: contacts", err)
		return
	}
	host, _ := s.queries.GetProfile(r.Context(), uid)
	for _, c := range contacts {
		body := renderEmail(emailContent{
			preheader: "Still deciding? One tap and you're done.",
			heading:   fmt.Sprintf("%s is waiting on you 👀", host.DisplayName),
			lines:     []string{fmt.Sprintf("Quick one - are you in for \"%s\"? One tap below and you're done.", ev.Title)},
			meta:      eventMeta(ev),
			ctaLabel:  "✅ I'm going",
			ctaURL:    s.rsvpLink(c.UserID, uuidStr(ev.ID), "going"),
			cta2Label: "Can't make it",
			cta2URL:   s.rsvpLink(c.UserID, uuidStr(ev.ID), "declined"),
			moreLabel: "See the details first",
			moreURL:   campaignURL(s.eventURL(ev.ID), "nudge"),
			logoURL:   s.logoURL(),
			unsubURL:  s.muteLink(c.UserID, uuidStr(ev.ID)),
		})
		s.notify.Send([]string{c.Email}, "Are you in? "+ev.Title, body)
	}
	if err := s.queries.MarkNudged(r.Context(), id); err != nil {
		s.internal(w, "nudge: mark", err)
		return
	}
	s.analytics.Capture(uid, "nudge_sent", map[string]any{"event_id": r.PathValue("id"), "recipients": len(contacts)})
	writeJSON(w, http.StatusOK, map[string]int{"nudged": len(contacts)})
}
