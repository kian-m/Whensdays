package main

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// mute.go - per-recipient muting of an event's notification email. Two ways in:
//   1. Signed-in toggle:  POST /api/events/{id}/mute  {muted: bool}
//   2. One-click from an email: GET /api/events/{id}/unsubscribe?token=...
//
// The one-click route is UNauthenticated by necessity (mail clients send no
// bearer). Identity + scope ride in an HMAC token binding (user_id, event_id),
// signed with the same server key as guest tokens (a distinct "mute|" payload
// namespace prevents a guest token from being replayed here). Muting only ever
// affects the token's own user and is fully reversible, so the capability is
// low-risk. Tokens don't expire - an unsubscribe link must keep working.

func (g guestSigner) signMute(userID, eventID string) string {
	return hmacSeal(g.key, "mute|"+userID+"|"+eventID)
}

func (g guestSigner) verifyMute(token string) (userID, eventID string, ok bool) {
	payload, ok := hmacOpen(g.key, token)
	if !ok {
		return "", "", false
	}
	parts := strings.SplitN(string(payload), "|", 3)
	if len(parts) != 3 || parts[0] != "mute" {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// muteLink builds the one-click unsubscribe URL embedded in a recipient's email.
func (s *server) muteLink(userID string, eventID string) string {
	if s.appOrigin == "" {
		return ""
	}
	return s.appOrigin + "/api/events/" + eventID + "/unsubscribe?token=" + s.guests.signMute(userID, eventID)
}

// handleMuteToggle is the signed-in in-app toggle.
func (s *server) handleMuteToggle(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if _, err := s.queries.GetEvent(r.Context(), id); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	var in struct {
		Muted bool `json:"muted"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.setMuted(r.Context(), id, uid, in.Muted); err != nil {
		s.internal(w, "mute toggle", err)
		return
	}
	s.analytics.Capture(uid, "event_notifications_muted", map[string]any{"event_id": r.PathValue("id"), "muted": in.Muted})
	writeJSON(w, http.StatusOK, map[string]bool{"muted": in.Muted})
}

func (s *server) setMuted(ctx context.Context, id pgtype.UUID, uid string, muted bool) error {
	if muted {
		return s.queries.MuteEvent(ctx, db.MuteEventParams{EventID: id, UserID: uid})
	}
	return s.queries.UnmuteEvent(ctx, db.UnmuteEventParams{EventID: id, UserID: uid})
}

// handleUnsubscribe is the UNauthenticated one-click link from an email. It mutes
// (or, with ?resub=1, re-enables) and renders a small self-contained confirmation
// page. A relaxed CSP is set for THIS response so the page can carry inline style
// + the logo; the strict API CSP still applies everywhere else.
func (s *server) handleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	pathID := r.PathValue("id")
	userID, eventID, ok := s.guests.verifyMute(r.URL.Query().Get("token"))
	if !ok || eventID != pathID {
		s.unsubPage(w, http.StatusForbidden, "This link isn't valid", "The unsubscribe link is invalid or malformed.", "", "")
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
	resub := r.URL.Query().Get("resub") == "1"
	if err := s.setMuted(r.Context(), id, userID, !resub); err != nil {
		s.unsubPage(w, http.StatusInternalServerError, "Something went wrong", "Please try again later.", "", "")
		return
	}
	s.analytics.Capture(userID, "event_notifications_muted", map[string]any{"event_id": eventID, "muted": !resub, "via": "email"})
	eventURL := s.eventURL(id)
	if resub {
		s.unsubPage(w, http.StatusOK, "You're back on 🔔",
			`You'll get notifications about "`+ev.Title+`" again.`, eventURL, "")
		return
	}
	// Offer a one-click undo (same token, resub=1).
	undo := s.appOrigin + "/api/events/" + eventID + "/unsubscribe?token=" + s.guests.signMute(userID, eventID) + "&resub=1"
	s.unsubPage(w, http.StatusOK, "You're unsubscribed 🔕",
		`You won't get any more emails about "`+ev.Title+`".`, eventURL, undo)
}

// unsubPage renders the confirmation. Script-free; inline style is allowed only
// via the per-response CSP override below.
func (s *server) unsubPage(w http.ResponseWriter, status int, title, msg, eventURL, undoURL string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Relax the strict API CSP just for this styled, script-free page.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'")
	logo := ""
	if s.appOrigin != "" {
		logo = fmt.Sprintf(`<img src="%s/apple-touch-icon.png" width="40" height="40" alt="" style="border-radius:10px;margin-bottom:14px">`, html.EscapeString(s.appOrigin))
	}
	links := ""
	if undoURL != "" {
		links += fmt.Sprintf(`<a href="%s" style="color:#ee6c4d;font-weight:600;text-decoration:none">Undo - keep me subscribed</a><br><br>`, html.EscapeString(undoURL))
	}
	if eventURL != "" {
		links += fmt.Sprintf(`<a href="%s" style="color:#9aa4b6;text-decoration:none">Open the event →</a>`, html.EscapeString(eventURL))
	}
	body := fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title></head><body style="margin:0;background:#10141f;color:#f4f1ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"><div style="max-width:440px;margin:12vh auto;padding:32px 28px;background:#1a2233;border:1px solid #2b3550;border-radius:14px;text-align:center">%s<h1 style="margin:0 0 10px;font-size:22px">%s</h1><p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#c9d1de">%s</p>%s</div></body></html>`,
		html.EscapeString(title), logo, html.EscapeString(title), html.EscapeString(msg), links)
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}
