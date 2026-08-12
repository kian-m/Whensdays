package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/clsandbox/api/internal/db"
)

// performers.go - V7 of the venue-pages playbook (docs/product/VENUE-PAGES.md):
// performers on events. Managers (host/cohost) attach a real user by handle -
// same add-by-handle shape as cohosts (comments.go) - but a performer starts
// 'pending' and their own consent is what gates DISTRIBUTION: the lineup
// displays on the event page immediately (the host's own claim about who's on
// it), but a pending performer never surfaces to their followers' feed/digest
// (see discover.go/followdigest.go) - only 'confirmed' does. This is the
// anti-hijack guard: without it, anyone could attach a well-known performer to
// an event and blast that performer's followers without their say-so.
//
// The performer confirms (or removes themselves) via an emailed one-tap link,
// same envelope idiom as rsvp|/mute|: HMAC namespace "perf|". Managers can also
// remove a performer in-app (mirrors cohost management); the performer can
// remove themselves anytime, pending or confirmed.

// performerOut adds the viewer's own follow state to a lineup row for the
// event-detail response - kind='host' following a performer is the same
// primitive as following any other person, so the Lineup FollowButton needs
// per-performer state the way the hero's "follow-host" already gets one flag
// (following_host) for the single host.
type performerOut struct {
	db.ListPerformersRow
	Following bool `json:"following"`
}

func (g guestSigner) signPerformer(userID, eventID string) string {
	return hmacSeal(g.key, "perf|"+userID+"|"+eventID)
}

func (g guestSigner) verifyPerformer(token string) (userID, eventID string, ok bool) {
	payload, ok := hmacOpen(g.key, token)
	if !ok {
		return "", "", false
	}
	parts := strings.SplitN(string(payload), "|", 3)
	if len(parts) != 3 || parts[0] != "perf" {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// performerLink builds a one-tap email URL for the performer. action is
// confirm|remove - unlike the signed token (which binds identity+event), the
// action itself rides unsigned in the query string, same tradeoff rsvp-link
// already makes with its own r=going|declined (the link is only ever seen by
// its recipient; low risk).
func (s *server) performerLink(userID, eventID, action string) string {
	if s.appOrigin == "" {
		return ""
	}
	return s.appOrigin + "/api/events/" + eventID + "/performers/link?token=" + s.guests.signPerformer(userID, eventID) + "&action=" + action
}

// notifyPerformerAdded emails the newly-added performer with one-tap Confirm/
// Remove links - the consent step that gates their followers ever seeing this
// event (see the file header).
func (s *server) notifyPerformerAdded(ctx context.Context, ev db.Event, adderID, adderName, performerID string) {
	if !s.notify.Enabled() {
		return
	}
	p, err := s.queries.GetProfile(ctx, performerID)
	if err != nil || p.Email == "" {
		return
	}
	eventID := uuidStr(ev.ID)
	body := renderEmail(emailContent{
		preheader: adderName + " added you to the lineup.",
		heading:   "You're on the lineup for " + ev.Title,
		lines:     []string{adderName + " added you as a performer for \"" + ev.Title + "\". Confirm to let your followers see it on their feed, or remove yourself if this isn't right."},
		meta:      eventMeta(ev),
		ctaLabel:  "Confirm",
		ctaURL:    s.performerLink(performerID, eventID, "confirm"),
		cta2Label: "Remove me",
		cta2URL:   s.performerLink(performerID, eventID, "remove"),
		moreLabel: "See the event",
		moreURL:   campaignURL(s.eventURL(ev.ID), "performer_added"),
		logoURL:   s.logoURL(),
		unsubURL:  s.muteLink(performerID, eventID),
		coverURL:  eventCover(ev),
		theme:     ev.Theme,
	})
	s.notify.Send([]string{p.Email}, adderName+" added you to the lineup of "+ev.Title, body)
}

// managerRole computes the caller's role from an already-loaded event, without
// a second GetEvent round trip - handlers here load the event once via
// requireActiveEvent (the V7 write guard) and derive role from that row.
func (s *server) managerRole(ctx context.Context, ev db.Event, uid string) string {
	if ev.HostID == uid {
		return "host"
	}
	if isCo, _ := s.queries.IsCohost(ctx, db.IsCohostParams{EventID: ev.ID, UserID: uid}); isCo {
		return "cohost"
	}
	return "guest"
}

// handleAddPerformer attaches a real user to the event's lineup by handle -
// manager-only, like cohosts. The row starts 'pending': display on the event
// page is immediate, but the performer's own confirmation is what's required
// before this event can reach their followers.
func (s *server) handleAddPerformer(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, ok := s.requireActiveEvent(w, r, id)
	if !ok {
		return
	}
	if !isManager(s.managerRole(r.Context(), ev, uid)) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not allowed"})
		return
	}
	var in struct {
		Handle string `json:"handle"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	prof, err := s.queries.GetProfileByHandle(r.Context(), strings.ToLower(strings.TrimSpace(in.Handle)))
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no one with that handle"})
		return
	}
	if err != nil {
		s.internal(w, "lookup performer", err)
		return
	}
	if err := s.queries.AddPerformer(r.Context(), db.AddPerformerParams{EventID: id, UserID: prof.UserID, AddedBy: uid}); err != nil {
		s.internal(w, "add performer", err)
		return
	}
	s.analytics.Capture(uid, "performer_added", map[string]any{"event_id": r.PathValue("id")})
	if adder, aerr := s.queries.GetProfile(r.Context(), uid); aerr == nil {
		s.notifyPerformerAdded(r.Context(), ev, uid, adder.DisplayName, prof.UserID)
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

// handleRemovePerformer takes someone off the lineup - a manager can remove
// anyone, a performer can always remove themselves (pending or confirmed).
func (s *server) handleRemovePerformer(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	target := r.PathValue("userId")
	ev, ok := s.requireActiveEvent(w, r, id)
	if !ok {
		return
	}
	if target != uid && !isManager(s.managerRole(r.Context(), ev, uid)) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not allowed"})
		return
	}
	if err := s.queries.RemovePerformer(r.Context(), db.RemovePerformerParams{EventID: id, UserID: target}); err != nil {
		s.internal(w, "remove performer", err)
		return
	}
	s.analytics.Capture(uid, "performer_removed", map[string]any{"event_id": r.PathValue("id"), "self": target == uid})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleConfirmPerformer is the in-app twin of the email Confirm link - self
// only, mirrors the pending-performer banner's Confirm button.
func (s *server) handleConfirmPerformer(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if _, ok := s.requireActiveEvent(w, r, id); !ok {
		return
	}
	_, err := s.queries.ConfirmPerformer(r.Context(), db.ConfirmPerformerParams{EventID: id, UserID: uid})
	changed := true
	if errors.Is(err, pgx.ErrNoRows) {
		changed, err = false, nil
	}
	if err != nil {
		s.internal(w, "confirm performer", err)
		return
	}
	s.analytics.Capture(uid, "performer_confirmed", map[string]any{"event_id": r.PathValue("id"), "changed": changed})
	writeJSON(w, http.StatusOK, map[string]bool{"confirmed": true})
}

// handlePerformerLink is the UNauthenticated one-tap email link - mail clients
// send no bearer, so identity+scope ride in the HMAC "perf|" token (same
// pattern as rsvp-link/unsubscribe). action=confirm|remove; renders the same
// script-free confirmation page as every other one-click email link.
func (s *server) handlePerformerLink(w http.ResponseWriter, r *http.Request) {
	pathID := r.PathValue("id")
	userID, eventID, ok := s.guests.verifyPerformer(r.URL.Query().Get("token"))
	if !ok || eventID != pathID {
		s.unsubPage(w, http.StatusForbidden, "This link isn't valid", "The lineup link is invalid or malformed.", "", "")
		return
	}
	action := r.URL.Query().Get("action")
	if !oneOf(action, "confirm", "remove") {
		s.unsubPage(w, http.StatusBadRequest, "This link isn't valid", "Unknown action.", "", "")
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
	if err != nil {
		s.unsubPage(w, http.StatusInternalServerError, "Something went wrong", "Please try again later.", "", "")
		return
	}
	if action == "remove" {
		if err := s.queries.RemovePerformer(r.Context(), db.RemovePerformerParams{EventID: id, UserID: userID}); err != nil {
			s.unsubPage(w, http.StatusInternalServerError, "Something went wrong", "Please try again later.", "", "")
			return
		}
		s.analytics.Capture(userID, "performer_removed", map[string]any{"event_id": eventID, "via": "email"})
		s.unsubPage(w, http.StatusOK, "You're off the lineup", fmt.Sprintf("You're removed from the lineup for %q.", ev.Title), s.eventURL(id), "")
		return
	}
	_, cerr := s.queries.ConfirmPerformer(r.Context(), db.ConfirmPerformerParams{EventID: id, UserID: userID})
	changed := true
	if errors.Is(cerr, pgx.ErrNoRows) {
		changed, cerr = false, nil
	}
	if cerr != nil {
		s.unsubPage(w, http.StatusInternalServerError, "Something went wrong", "Please try again later.", "", "")
		return
	}
	s.analytics.Capture(userID, "performer_confirmed", map[string]any{"event_id": eventID, "via": "email", "changed": changed})
	s.unsubPage(w, http.StatusOK, "You're confirmed", fmt.Sprintf("You're on the lineup for %q - your followers may now see this event.", ev.Title), s.eventURL(id), "")
}
