package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/clsandbox/api/internal/db"
)

// guests.go — frictionless guest access (growth priority #1). An invitee can
// join an event from its link with just a name: POST /api/guest/join mints a
// low-privilege user ("guest_<id>") plus an HMAC-signed bearer token the web
// stores locally. Guests are real users — every query is already scoped to the
// authenticated user id, and the invite link remains the only capability — so
// they can RSVP, vote, comment, and even host (participant→host conversion).
// No account merging yet; signing up later starts a fresh identity.

const guestTokenTTL = 90 * 24 * time.Hour

type guestSigner struct{ key []byte }

// newGuestSigner reads GUEST_TOKEN_KEY. Dev mode falls back to a fixed key so
// hermetic E2E tokens are stable; otherwise an ephemeral random key is used
// (tokens survive until restart) with a warning.
func newGuestSigner(logger *slog.Logger) guestSigner {
	if k := os.Getenv("GUEST_TOKEN_KEY"); k != "" {
		return guestSigner{key: []byte(k)}
	}
	if os.Getenv("AUTH_MODE") == "dev" {
		return guestSigner{key: []byte("dev-guest-token-key")}
	}
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	logger.Warn("GUEST_TOKEN_KEY unset: guest tokens will not survive restarts")
	return guestSigner{key: k}
}

func (g guestSigner) sign(userID string) string {
	payload := userID + "|" + strconv.FormatInt(time.Now().Add(guestTokenTTL).Unix(), 10)
	mac := hmac.New(sha256.New, g.key)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(mac.Sum(nil))
}

func (g guestSigner) verify(token string) (string, bool) {
	dot := strings.LastIndex(token, ".")
	if dot < 0 {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(token[:dot])
	if err != nil {
		return "", false
	}
	mac := hmac.New(sha256.New, g.key)
	mac.Write(payload)
	if !hmac.Equal([]byte(token[dot+1:]), []byte(hex.EncodeToString(mac.Sum(nil)))) {
		return "", false
	}
	parts := strings.SplitN(string(payload), "|", 2)
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "guest_") {
		return "", false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	return parts[0], true
}

// handleGuestJoin is UNauthenticated by design: the event id in the body is the
// capability (same model as the invite link).
func (s *server) handleGuestJoin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		EventID string `json:"event_id"`
		Name    string `json:"name"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 80 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name is required"})
		return
	}
	// Two entry paths: joining an existing event (the id is the capability) or
	// starting a brand-new plan with no account ("Start a plan" on the landing
	// page) — guests are full users, so they can host.
	if in.EventID != "" {
		id, ok := parseUUID(in.EventID)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "valid event_id required"})
			return
		}
		if _, err := s.queries.GetEvent(r.Context(), id); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "event not found"})
			return
		}
	}
	suffix := make([]byte, 8)
	_, _ = rand.Read(suffix)
	uid := "guest_" + hex.EncodeToString(suffix)
	prof, err := s.queries.UpsertProfile(r.Context(), db.UpsertProfileParams{
		UserID: uid, DisplayName: in.Name, Handle: fmt.Sprintf("guest-%x", suffix[:3]), Email: "",
	})
	if err != nil {
		s.internal(w, "guest join", err)
		return
	}
	s.analytics.Capture(uid, "guest_joined", map[string]any{"event_id": in.EventID})
	writeJSON(w, http.StatusCreated, map[string]string{
		"token": s.guests.sign(uid), "user_id": prof.UserID, "display_name": prof.DisplayName,
	})
}
