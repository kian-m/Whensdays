package main

import (
	"net/http"

	"github.com/clsandbox/api/internal/db"
)

// invites.go — direct friend invites (a growth loop: any participant can pull
// their own friends in) + the nav badge counts.

// handleInviteFriend invites one of YOUR friends to an event you can see.
// Friendship is the permission: you can only invite accepted friends.
func (s *server) handleInviteFriend(w http.ResponseWriter, r *http.Request) {
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
	var in struct {
		FriendID string `json:"friend_id"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.FriendID == "" || in.FriendID == uid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "friend_id required"})
		return
	}
	friends, err := s.queries.AreFriends(r.Context(), db.AreFriendsParams{RequesterID: uid, AddresseeID: in.FriendID})
	if err != nil || !friends {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "you can only invite your friends"})
		return
	}
	if err := s.queries.AddEventInvite(r.Context(), db.AddEventInviteParams{EventID: id, UserID: in.FriendID, InviterID: uid}); err != nil {
		s.internal(w, "add invite", err)
		return
	}
	s.analytics.Capture(uid, "event_invite_sent", map[string]any{"event_id": r.PathValue("id")})
	// Best-effort email to the invitee.
	if s.notify.Enabled() {
		if p, err := s.queries.GetProfile(r.Context(), in.FriendID); err == nil && p.Email != "" {
			if inviter, err := s.queries.GetProfile(r.Context(), uid); err == nil {
				body := renderEmail(emailContent{
					preheader: inviter.DisplayName + " invited you to " + ev.Title,
					heading:   "You're invited to " + ev.Title,
					lines:     []string{inviter.DisplayName + " invited you. Open the event to say if you can make it and add your availability."},
					meta:      eventMeta(ev),
					ctaLabel:  "RSVP now →",
					ctaURL:    campaignURL(s.eventURL(ev.ID), "invite"),
					logoURL:   s.logoURL(),
					unsubURL:  s.muteLink(in.FriendID, uuidStr(ev.ID)),
				})
				s.notify.Send([]string{p.Email}, "You're invited: "+ev.Title, body)
			}
		}
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

// handleBadges returns the red-dot counts for the nav: pending incoming friend
// requests + unseen event invites (cleared when the dashboard lists them).
func (s *server) handleBadges(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	invites, err := s.queries.CountUnseenInvites(r.Context(), uid)
	if err != nil {
		s.internal(w, "count invites", err)
		return
	}
	requests, err := s.queries.CountPendingIncoming(r.Context(), uid)
	if err != nil {
		s.internal(w, "count requests", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int32{"invites": invites, "friend_requests": requests})
}

// handleListCustomTypes returns the user's saved custom event types (emoji +
// short name) for reuse as wizard chips.
func (s *server) handleListCustomTypes(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	types, err := s.queries.ListCustomTypes(r.Context(), uid)
	if err != nil {
		s.internal(w, "list custom types", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"types": types})
}

// handleDeleteCustomType removes one of the user's saved custom types (by its
// label). Existing events keep their custom emoji/label — this only removes
// the reusable wizard chip.
func (s *server) handleDeleteCustomType(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	label := r.PathValue("label")
	if label == "" || len(label) > 40 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid label"})
		return
	}
	if err := s.queries.DeleteCustomType(r.Context(), db.DeleteCustomTypeParams{UserID: uid, Label: label}); err != nil {
		s.internal(w, "delete custom type", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
