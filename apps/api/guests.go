package main

import (
	"context"
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
		UserID: uid, DisplayName: in.Name, Handle: fmt.Sprintf("guest-%x", suffix[:3]),
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

// --- guest → account merge ---
//
// When a guest (guest_<id>) signs up, their content must follow them. This
// reassigns every guest-owned row to the new authenticated user in one
// transaction, then drops the guest profile so the real account keeps a clean
// handle (the web prefills the guest's name into profile setup). A fresh
// account has no prior rows, so reassignment can't collide; the unique-keyed
// tables still delete any dup first so the merge is idempotent/safe if re-run.
//
// Table + column names below are compile-time constants (never user input);
// the ids are always parameterized — no injection surface. This bulk cross-
// table migration is the one place sqlc's one-statement-per-query model fits
// poorly, so it lives here as a single audited function.

// uniqueOwned: tables with a UNIQUE/PK over (user_id, <key>) — delete guest
// dups that the target already has, then reassign the rest.
var uniqueOwned = []struct{ table, key string }{
	{"event_attendees", "event_id"},
	{"event_time_votes", "option_id"},
	{"event_preference_answers", "event_id, question_key"},
	{"event_general_votes", "event_id, dimension, value"},
	{"event_cohosts", "event_id"},
	{"group_members", "group_id"},
	{"follows", "kind, value"},
	{"custom_event_types", "label"},
	{"calendar_connections", "provider"},
	{"availability_slots", "weekday, part_of_day"},
	{"availability_days", "day, daypart"},
}

// plainOwned: tables whose owning column is user-scoped with no per-user unique
// constraint that a fresh account could collide on.
var plainOwned = []struct{ table, col string }{
	{"events", "host_id"},
	{"groups", "owner_id"},
	{"event_comments", "user_id"},
	{"event_invites", "user_id"},
	{"notes", "user_id"},
}

func (s *server) mergeGuestInto(ctx context.Context, oldID, newID string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var guestName string
	_ = tx.QueryRow(ctx, "SELECT display_name FROM profiles WHERE user_id=$1", oldID).Scan(&guestName)

	for _, t := range uniqueOwned {
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			"DELETE FROM %s WHERE user_id=$1 AND (%s) IN (SELECT %s FROM %s WHERE user_id=$2)",
			t.table, t.key, t.key, t.table), oldID, newID); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf("UPDATE %s SET user_id=$2 WHERE user_id=$1", t.table), oldID, newID); err != nil {
			return "", err
		}
	}
	for _, t := range plainOwned {
		if _, err := tx.Exec(ctx, fmt.Sprintf("UPDATE %s SET %s=$2 WHERE %s=$1", t.table, t.col, t.col), oldID, newID); err != nil {
			return "", err
		}
	}
	// friendships: two directional columns, each with a UNIQUE(requester,addressee).
	for _, col := range []string{"requester_id", "addressee_id"} {
		other := "addressee_id"
		if col == "addressee_id" {
			other = "requester_id"
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			"DELETE FROM friendships WHERE %s=$1 AND %s IN (SELECT %s FROM friendships WHERE %s=$2)",
			col, other, other, col), oldID, newID); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf("UPDATE friendships SET %s=$2 WHERE %s=$1", col, col), oldID, newID); err != nil {
			return "", err
		}
	}
	// Drop any now-self friendships the reassignment could create.
	if _, err := tx.Exec(ctx, "DELETE FROM friendships WHERE requester_id = addressee_id"); err != nil {
		return "", err
	}
	// The guest profile is discarded — the real account makes its own (name prefilled).
	if _, err := tx.Exec(ctx, "DELETE FROM profiles WHERE user_id=$1", oldID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return guestName, nil
}

// handleGuestMerge reassigns a guest's content to the current authenticated
// user. Requires BOTH proofs: the Clerk/dev session (target account) AND a
// valid guest token in the body (proves ownership of the guest identity).
func (s *server) handleGuestMerge(w http.ResponseWriter, r *http.Request) {
	newID, _ := userIDFrom(r.Context())
	if strings.HasPrefix(newID, "guest_") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "sign in first"})
		return
	}
	var in struct {
		GuestToken string `json:"guest_token"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	oldID, ok := s.guests.verify(in.GuestToken)
	if !ok {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid guest token"})
		return
	}
	if oldID == newID {
		writeJSON(w, http.StatusOK, map[string]any{"merged": false})
		return
	}
	name, err := s.mergeGuestInto(r.Context(), oldID, newID)
	if err != nil {
		s.internal(w, "guest merge", err)
		return
	}
	s.analytics.Capture(newID, "guest_merged", map[string]any{"from": oldID})
	writeJSON(w, http.StatusOK, map[string]any{"merged": true, "name": name})
}
