package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// scheduler.go holds the "Whensdays" feature: profiles, general
// availability, friends, and events (with availability polls + per-event-type
// preference questions). Every handler scopes its writes/reads to the
// authenticated user (userIDFrom) - never a user id from the request body.

const maxBody = 1 << 16

// --- small validation/parse helpers ---

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func parseUUID(s string) (pgtype.UUID, bool) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return u, false
	}
	return u, u.Valid
}

func parseTS(s string) (pgtype.Timestamptz, bool) {
	var ts pgtype.Timestamptz
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return ts, false
	}
	ts.Time = t
	ts.Valid = true
	return ts, true
}

func parseDate(s string) (pgtype.Date, bool) {
	var d pgtype.Date
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return d, false
	}
	d.Time = t
	d.Valid = true
	return d, true
}

// formatDays renders date-availability rows as plain {day, daypart} JSON.
func formatDays(rows []db.ListAvailabilityDaysRow) []map[string]string {
	out := make([]map[string]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]string{"day": r.Day.Time.Format("2006-01-02"), "daypart": r.Daypart, "status": r.Status})
	}
	return out
}

// availStatus validates an availability cell status. Empty is allowed for
// backward compatibility (older clients that only sent free cells) and is
// treated as "free" by orFree.
func availStatus(s string) bool { return s == "" || s == "free" || s == "busy" }

// orFree defaults an empty status to "free".
func orFree(s string) string {
	if s == "" {
		return "free"
	}
	return s
}

// dayparts are the coarse time-of-day buckets used by general-availability polls.
var dayparts = []string{"early_morning", "morning", "noon", "afternoon", "evening", "night"}

// timeInPast rejects event times more than an hour behind now (grace covers
// clock skew and "starting right now" events). Dev mode is exempt: hermetic
// E2E deliberately backdates events to simulate history (streaks, Past tab) -
// same dev-only escape as the rate limiter.
func timeInPast(ts pgtype.Timestamptz) bool {
	if os.Getenv("AUTH_MODE") == "dev" {
		return false
	}
	return time.Since(ts.Time) > time.Hour
}

// hourToDaypart buckets an hour like the web's helper of the same name - keep
// the two in sync (lib.tsx).
func hourToDaypart(h int) string {
	switch {
	case h < 8:
		return "early_morning"
	case h < 11:
		return "morning"
	case h < 14:
		return "noon"
	case h < 17:
		return "afternoon"
	case h < 21:
		return "evening"
	default:
		return "night"
	}
}

// availabilityHorizonDays is how far ahead explicit date-based availability can be
// set (the web paginates this window two weeks at a time).
const availabilityHorizonDays = 84

// validMonth checks a "YYYY-MM" value.
func validMonth(s string) bool {
	t, err := time.Parse("2006-01", s)
	return err == nil && t.Year() >= 2000 && t.Year() <= 2100
}

// slugify turns a display name into a handle-safe slug (a-z, 0-9, -), capped.
func slugify(name string) string {
	var b []rune
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b = append(b, r)
		case r == ' ' || r == '-' || r == '_':
			if len(b) > 0 && b[len(b)-1] != '-' {
				b = append(b, '-')
			}
		}
		if len(b) >= 20 {
			break
		}
	}
	out := strings.Trim(string(b), "-")
	if out == "" {
		out = "friend"
	}
	return out
}

// newUUID generates a random v4 UUID (crypto/rand; no dependency).
func newUUID() pgtype.UUID {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return pgtype.UUID{Bytes: b, Valid: true}
}

// shiftOccurrence returns the i-th occurrence time of a recurring series.
func shiftOccurrence(base pgtype.Timestamptz, repeat string, i int) pgtype.Timestamptz {
	t := base.Time
	switch repeat {
	case "weekly":
		t = t.AddDate(0, 0, 7*i)
	case "biweekly":
		t = t.AddDate(0, 0, 14*i)
	case "monthly":
		t = t.AddDate(0, i, 0)
	}
	return pgtype.Timestamptz{Time: t, Valid: true}
}

func uuidStr(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	b := u.Bytes
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// handleFlags returns every PostHog feature flag evaluated for the current user
// (empty object when analytics is disabled).
func (s *server) handleFlags(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	writeJSON(w, http.StatusOK, s.analytics.AllFlags(uid))
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeJSONLimit(w, r, dst, maxBody)
}

// decodeJSONLimit is decodeJSON with a custom body cap - for the few endpoints
// that legitimately carry a data-URL image (event covers).
func decodeJSONLimit(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit)).Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return false
	}
	return true
}

func (s *server) internal(w http.ResponseWriter, what string, err error) {
	s.logger.Error(what, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ============================ profiles ============================

func (s *server) handleGetProfile(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	p, err := s.queries.GetProfile(r.Context(), uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no profile"})
		return
	}
	if err != nil {
		s.internal(w, "get profile", err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *server) handleUpsertProfile(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		DisplayName string `json:"display_name"`
		Handle      string `json:"handle"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	in.Handle = strings.ToLower(strings.TrimSpace(in.Handle))
	if in.DisplayName == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "display_name is required"})
		return
	}
	// Handles are an ACCOUNT feature: guests can't claim one (their auto slug
	// keeps friend/mention plumbing working, but a chosen name is reserved for
	// people who sign up - it's also a conversion nudge).
	if strings.HasPrefix(uid, "guest_") {
		in.Handle = ""
	}
	// One-field onboarding: no handle → derive one from the name (slug + a
	// random suffix on collision below).
	autoHandle := in.Handle == ""
	if autoHandle {
		in.Handle = slugify(in.DisplayName)
	}
	if len(in.DisplayName) > 80 || len(in.Handle) > 40 || !validHandle(in.Handle) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "handle must be 1-40 chars: a-z, 0-9, _ or -"})
		return
	}
	p, err := s.queries.UpsertProfile(r.Context(), db.UpsertProfileParams{
		UserID: uid, DisplayName: in.DisplayName, Handle: in.Handle,
	})
	if isUniqueViolation(err) && autoHandle {
		// Derived handle collided - retry with a random suffix.
		var b [3]byte
		_, _ = rand.Read(b[:])
		in.Handle = in.Handle + "-" + fmt.Sprintf("%x", b)
		p, err = s.queries.UpsertProfile(r.Context(), db.UpsertProfileParams{
			UserID: uid, DisplayName: in.DisplayName, Handle: in.Handle,
		})
	}
	if isUniqueViolation(err) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "handle already taken"})
		return
	}
	if err != nil {
		s.internal(w, "upsert profile", err)
		return
	}
	s.analytics.Identify(uid, map[string]any{"handle": p.Handle, "name": p.DisplayName})
	s.analytics.Capture(uid, "profile_updated", map[string]any{"handle": p.Handle})
	writeJSON(w, http.StatusOK, p)
}

// handleSetProfileEmail syncs the address from the auth provider (Clerk owns it;
// the client mirrors the verified primary email here so transactional email has a
// destination). Email is never user-typed in our UI - it comes from a verified
// Clerk address - but we still validate shape defensively. Empty string clears it.
func (s *server) handleSetProfileEmail(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Email string `json:"email"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if in.Email != "" && (len(in.Email) > 254 || !strings.Contains(in.Email, "@")) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid email"})
		return
	}
	p, err := s.queries.SetProfileEmail(r.Context(), db.SetProfileEmailParams{UserID: uid, Email: in.Email})
	if err != nil {
		// No profile row yet (email sync can race ahead of profile creation on a
		// fresh sign-up) - not an error worth surfacing; the next sync will land.
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		s.internal(w, "set profile email", err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// handleSetAvatar stores a profile picture: a resized image data URL (default
// from the web client) or an https URL. Bigger body limit than other endpoints
// to fit a small base64 image; the stored value is still capped.
func (s *server) handleSetAvatar(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(in.AvatarURL) > 300_000 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "image too large (max ~300KB)"})
		return
	}
	// data:image only - the web always uploads a resized data URL (fileToAvatar);
	// allowing arbitrary https would let one user's avatar make every viewer's
	// browser fetch an attacker URL (tracking / internal-SSRF from the client).
	if in.AvatarURL != "" && !strings.HasPrefix(in.AvatarURL, "data:image/") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "avatar must be an uploaded image"})
		return
	}
	p, err := s.queries.SetAvatar(r.Context(), db.SetAvatarParams{UserID: uid, AvatarUrl: in.AvatarURL})
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "set up your profile first"})
		return
	}
	if err != nil {
		s.internal(w, "set avatar", err)
		return
	}
	s.analytics.Capture(uid, "avatar_updated", map[string]any{"has_photo": in.AvatarURL != ""})
	writeJSON(w, http.StatusOK, p)
}

func validHandle(h string) bool {
	for _, c := range h {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// ======================== availability ============================

func (s *server) handleGetAvailability(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	slots, err := s.queries.ListAvailability(r.Context(), uid)
	if err != nil {
		s.internal(w, "list availability", err)
		return
	}
	writeJSON(w, http.StatusOK, slots)
}

func (s *server) handlePutAvailability(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Slots []struct {
			Weekday   int16  `json:"weekday"`
			PartOfDay string `json:"part_of_day"`
			Status    string `json:"status"`
		} `json:"slots"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	for _, sl := range in.Slots {
		if sl.Weekday < 0 || sl.Weekday > 6 || !oneOf(sl.PartOfDay, "morning", "afternoon", "evening") || !availStatus(sl.Status) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid slot"})
			return
		}
	}
	if err := s.queries.ClearAvailability(r.Context(), uid); err != nil {
		s.internal(w, "clear availability", err)
		return
	}
	for _, sl := range in.Slots {
		if err := s.queries.AddAvailabilitySlot(r.Context(), db.AddAvailabilitySlotParams{
			UserID: uid, Weekday: sl.Weekday, PartOfDay: sl.PartOfDay, Status: orFree(sl.Status),
		}); err != nil {
			s.internal(w, "add availability", err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- date-based availability (the explicit, concrete-dates view) ---

func (s *server) handleGetAvailabilityDays(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	rows, err := s.queries.ListAvailabilityDays(r.Context(), uid)
	if err != nil {
		s.internal(w, "list availability days", err)
		return
	}
	// Commitments (events you're going to) ride along so RSVPs automatically
	// overlay the grid as booked - derived, never written into availability, so
	// nothing goes stale when plans change. Same shape as the friend endpoint.
	commitments, err := s.queries.ListUpcomingCommitments(r.Context(), uid)
	if err != nil {
		s.internal(w, "own commitments", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": formatDays(rows), "commitments": commitments})
}

func (s *server) handlePutAvailabilityDays(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Days []struct {
			Day     string `json:"day"`
			Daypart string `json:"daypart"`
			Status  string `json:"status"`
		} `json:"days"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	// Cap total selections to the paginated horizon (availabilityHorizonDays of
	// concrete dates, each with up to len(dayparts) cells).
	if len(in.Days) > availabilityHorizonDays*len(dayparts) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "too many selections"})
		return
	}
	type cell struct {
		d      pgtype.Date
		dp     string
		status string
	}
	cells := make([]cell, 0, len(in.Days))
	for _, c := range in.Days {
		d, ok := parseDate(c.Day)
		if !ok || !oneOf(c.Daypart, dayparts...) || !availStatus(c.Status) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid availability cell"})
			return
		}
		cells = append(cells, cell{d, c.Daypart, orFree(c.Status)})
	}
	if err := s.queries.ClearAvailabilityDays(r.Context(), uid); err != nil {
		s.internal(w, "clear availability days", err)
		return
	}
	for _, c := range cells {
		if err := s.queries.AddAvailabilityDay(r.Context(), db.AddAvailabilityDayParams{
			UserID: uid, Day: c.d, Daypart: c.dp, Status: c.status,
		}); err != nil {
			s.internal(w, "add availability day", err)
			return
		}
	}
	s.analytics.Capture(uid, "availability_updated", map[string]any{"cells": len(cells)})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// =========================== events ===============================

func (s *server) handleListEvents(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	hosting, err := s.queries.ListEventsHosting(r.Context(), uid)
	if err != nil {
		s.internal(w, "list hosting", err)
		return
	}
	// Cohosted events belong under Hosting too - a cohost helps run the event
	// and must see it on their dashboard without ever opening the invite link.
	cohosting, err := s.queries.ListEventsCohosting(r.Context(), uid)
	if err != nil {
		s.internal(w, "list cohosting", err)
		return
	}
	hosting = append(hosting, cohosting...)
	attending, err := s.queries.ListEventsAttending(r.Context(), uid)
	if err != nil {
		s.internal(w, "list attending", err)
		return
	}
	invited, err := s.queries.ListEventsInvited(r.Context(), uid)
	if err != nil {
		s.internal(w, "list invited", err)
		return
	}
	attending = append(attending, invited...)
	// Per-event "new" markers: ids of invited events the user hasn't opened yet.
	// (Cleared one at a time in handleGetEvent, not en masse here - so the alert
	// stays on each event until it's actually opened.)
	unseenRows, err := s.queries.ListUnseenInviteEventIDs(r.Context(), uid)
	if err != nil {
		s.internal(w, "list unseen invites", err)
		return
	}
	unseen := make([]string, 0, len(unseenRows))
	for _, u := range unseenRows {
		unseen = append(unseen, uuidStr(u))
	}

	// Avatar-stack previews: one batched query over every listed event. Keyed
	// by event id; each entry carries ≤6 prioritized faces + the going total.
	ids := make([]pgtype.UUID, 0, len(hosting)+len(attending))
	for _, ev := range hosting {
		ids = append(ids, ev.ID)
	}
	for _, ev := range attending {
		ids = append(ids, ev.ID)
	}
	type face struct {
		Name     string `json:"name"`
		Avatar   string `json:"avatar_url"`
		IsFriend bool   `json:"is_friend"`
	}
	type pile struct {
		Faces []face `json:"faces"`
		Going int32  `json:"going"`
	}
	faces := map[string]*pile{}
	if len(ids) > 0 {
		rows, err := s.queries.ListGoingFaces(r.Context(), db.ListGoingFacesParams{RequesterID: uid, Column2: ids})
		if err != nil {
			s.internal(w, "list going faces", err)
			return
		}
		for _, row := range rows {
			k := uuidStr(row.EventID)
			if faces[k] == nil {
				faces[k] = &pile{Faces: []face{}}
			}
			faces[k].Faces = append(faces[k].Faces, face{Name: row.DisplayName, Avatar: row.AvatarUrl, IsFriend: row.IsFriend})
			faces[k].Going = row.GoingCount
		}
	}
	// The viewer's own rsvp per event: past tiles render Attended vs Passed.
	myRsvps := map[string]string{}
	if rows, err := s.queries.ListMyRsvps(r.Context(), uid); err == nil {
		for _, row := range rows {
			myRsvps[uuidStr(row.EventID)] = row.Rsvp
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"hosting": hosting, "attending": attending, "unseen": unseen, "faces": faces, "my_rsvps": myRsvps})
}

// pollClosed reports whether a poll's optional close date has passed - votes
// are rejected after it (the host can still finalize any time).
func pollClosed(ev db.Event) bool {
	return ev.Status == "polling" && ev.PollDeadline.Valid && time.Now().After(ev.PollDeadline.Time)
}

// requireActiveEvent loads an event and rejects writes against cancelled ones
// (the UI hides those surfaces; the API must enforce it too).
func (s *server) requireActiveEvent(w http.ResponseWriter, r *http.Request, id pgtype.UUID) (db.Event, bool) {
	ev, err := s.queries.GetEvent(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return ev, false
	}
	if err != nil {
		s.internal(w, "load event", err)
		return ev, false
	}
	if ev.Status == "cancelled" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "event is cancelled"})
		return ev, false
	}
	return ev, true
}

func (s *server) handleCreateEvent(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Title           string   `json:"title"`
		EventType       string   `json:"event_type"`
		Description     string   `json:"description"`
		LocationMode    string   `json:"location_mode"`
		LocationAddress string   `json:"location_address"`
		SchedulingMode  string   `json:"scheduling_mode"`
		StartsAt        string   `json:"starts_at"`     // RFC3339, for fixed mode
		EndsAt          string   `json:"ends_at"`       // optional RFC3339 end (fixed mode)
		TimeOptions     []string `json:"time_options"`  // RFC3339[], for poll mode
		GroupID         string   `json:"group_id"`      // optional: attach to a group
		Repeat          string   `json:"repeat"`        // optional: weekly|biweekly|monthly (fixed mode only)
		RepeatCount     int      `json:"repeat_count"`  // total occurrences, 2-12 (default 4)
		MoreStarts      []string `json:"more_starts"`   // optional extra dates (fixed mode): an IRREGULAR series - recurring, no exact pattern
		InviteFrom      string   `json:"invite_from"`   // optional event id: re-poll - copy that event's people as invites (+ email them)
		Visibility      string   `json:"visibility"`    // optional: private (default) | public
		Topic           string   `json:"topic"`         // optional slug, for public discovery
		City            string   `json:"city"`          // optional, for public discovery
		CustomEmoji     string   `json:"custom_emoji"`  // optional user-defined type (with label)
		CustomLabel     string   `json:"custom_label"`  // ≤20 chars; forces event_type=other
		GeneralScope    string   `json:"general_scope"` // general mode: week|month|general (default general)
		Timezone        string   `json:"timezone"`      // host's IANA tz (e.g. America/Los_Angeles); for server-rendered times
		PollDeadline    string   `json:"poll_deadline"` // optional RFC3339 close date (poll/general modes)
		Capacity        int      `json:"capacity"`      // optional max going (0 = unlimited)
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	in.Description = strings.TrimSpace(in.Description)
	in.LocationAddress = strings.TrimSpace(in.LocationAddress)
	if in.Title == "" || len(in.Title) > 140 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "title is required (max 140)"})
		return
	}
	if !oneOf(in.EventType, "dinner", "drinks", "movie", "camping", "party", "trip", "show", "practice", "openmic", "other") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid event_type"})
		return
	}
	// User-defined type: an emoji + short name, displayed instead of the preset
	// type; the event itself is stored as 'other' so downstream logic holds.
	in.CustomLabel = strings.TrimSpace(in.CustomLabel)
	if in.CustomLabel != "" {
		if utf8.RuneCountInString(in.CustomLabel) > 20 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "custom type name: max 20 characters"})
			return
		}
		if !validEmoji(in.CustomEmoji) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "custom type needs an emoji"})
			return
		}
		in.EventType = "other"
	} else {
		in.CustomEmoji = ""
	}
	if !oneOf(in.LocationMode, "host_place", "find_venue") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid location_mode"})
		return
	}
	if !oneOf(in.SchedulingMode, "fixed", "poll", "general") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid scheduling_mode"})
		return
	}
	// The scope shapes what a general poll asks ("this week" / "this month" /
	// "generally"); it's meaningless for other modes, so normalize those.
	if in.GeneralScope == "" || in.SchedulingMode != "general" {
		in.GeneralScope = "general"
	}
	if !oneOf(in.GeneralScope, "week", "month", "general") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid general_scope"})
		return
	}

	in.Topic = strings.ToLower(strings.TrimSpace(in.Topic))
	in.City = strings.TrimSpace(in.City)
	if err := validatePublicFields(in.Visibility, in.Topic, in.City); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if in.Visibility == "" {
		in.Visibility = "private"
	}
	// Timezone: accept only a valid IANA name (parseable by the tz database);
	// anything else is dropped to "" so email formatting falls back to the app tz.
	tz := strings.TrimSpace(in.Timezone)
	if tz != "" {
		if _, err := time.LoadLocation(tz); err != nil {
			tz = ""
		}
	}
	params := db.CreateEventParams{
		HostID: uid, Title: in.Title, EventType: in.EventType, Description: in.Description,
		LocationMode: in.LocationMode, LocationAddress: in.LocationAddress, SchedulingMode: in.SchedulingMode,
		Visibility: in.Visibility, Topic: in.Topic, City: in.City,
		CustomEmoji: in.CustomEmoji, CustomLabel: in.CustomLabel, GeneralScope: in.GeneralScope,
		Timezone: tz,
	}
	if in.Capacity < 0 || in.Capacity > 500 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "capacity must be 0-500"})
		return
	}
	params.Capacity = int32(in.Capacity)
	// Poll close date: optional, poll/general only, must be in the future
	// (dev-exempt like every time check so hermetic E2E can backdate).
	if in.PollDeadline != "" {
		if in.SchedulingMode == "fixed" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "poll_deadline needs a poll"})
			return
		}
		dts, dok := parseTS(in.PollDeadline)
		if !dok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid poll_deadline"})
			return
		}
		if timeInPast(dts) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "poll_deadline can't be in the past"})
			return
		}
		params.PollDeadline = dts
	}
	if in.GroupID != "" {
		gid, ok := parseUUID(in.GroupID)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid group_id"})
			return
		}
		member, err := s.queries.IsGroupMember(r.Context(), db.IsGroupMemberParams{ID: gid, UserID: uid})
		if err != nil || !member {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of that group"})
			return
		}
		params.GroupID = gid
	}
	var options []pgtype.Timestamptz
	switch in.SchedulingMode {
	case "fixed":
		ts, ok := parseTS(in.StartsAt)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "fixed events need a valid starts_at"})
			return
		}
		if timeInPast(ts) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
			return
		}
		params.StartsAt = ts
		if in.EndsAt != "" {
			ets, eok := parseTS(in.EndsAt)
			if !eok || !ets.Time.After(ts.Time) {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "end time must be after the start"})
				return
			}
			params.EndsAt = ets
		}
		params.Status = "scheduled"
	case "poll":
		if len(in.TimeOptions) < 1 || len(in.TimeOptions) > 20 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "polls need 1-20 time options"})
			return
		}
		for _, o := range in.TimeOptions {
			ts, ok := parseTS(o)
			if !ok {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid time option"})
				return
			}
			options = append(options, ts)
		}
		params.Status = "polling"
	case "general":
		// Guests submit coarse month/weekday/daypart preferences after creation.
		params.Status = "polling"
	}

	// Recurrence: fixed-time events can repeat. Occurrences are materialized now
	// as separate events sharing a series_id - per-occurrence RSVPs, no cron.
	if in.Repeat != "" {
		if !oneOf(in.Repeat, "weekly", "biweekly", "monthly") || in.SchedulingMode != "fixed" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "repeat must be weekly/biweekly/monthly, on a fixed-time event"})
			return
		}
		if len(in.MoreStarts) > 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "pick a repeat pattern OR extra dates, not both"})
			return
		}
		if in.RepeatCount == 0 {
			in.RepeatCount = 4
		}
		if in.RepeatCount < 2 || in.RepeatCount > 12 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "repeat_count must be 2-12"})
			return
		}
		params.SeriesID = newUUID()
		params.Recurrence = in.Repeat
	}
	// Irregular series: explicit extra dates, any days - recurring without a
	// pattern ("next three: the 12th, the 23rd, then a Tuesday"). Same series
	// machinery as repeat, just with host-picked times.
	var moreStarts []pgtype.Timestamptz
	if len(in.MoreStarts) > 0 {
		if in.SchedulingMode != "fixed" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "extra dates need a fixed-time event"})
			return
		}
		if len(in.MoreStarts) > 11 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "at most 12 dates per series"})
			return
		}
		for _, raw := range in.MoreStarts {
			ts, ok := parseTS(raw)
			if !ok {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid extra date"})
				return
			}
			if timeInPast(ts) {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
				return
			}
			moreStarts = append(moreStarts, ts)
		}
		params.SeriesID = newUUID()
		params.Recurrence = "custom"
	}

	ev, err := s.queries.CreateEvent(r.Context(), params)
	if err != nil {
		s.internal(w, "create event", err)
		return
	}
	if in.CustomLabel != "" {
		_ = s.queries.UpsertCustomType(r.Context(), db.UpsertCustomTypeParams{UserID: uid, Label: in.CustomLabel, Emoji: in.CustomEmoji})
	}
	// Remaining occurrences of a series (first one is ev above).
	for i := 1; in.Repeat != "" && i < in.RepeatCount; i++ {
		p := params
		p.StartsAt = shiftOccurrence(params.StartsAt, in.Repeat, i)
		if params.EndsAt.Valid {
			p.EndsAt = pgtype.Timestamptz{Time: p.StartsAt.Time.Add(params.EndsAt.Time.Sub(params.StartsAt.Time)), Valid: true}
		}
		if _, err := s.queries.CreateEvent(r.Context(), p); err != nil {
			s.internal(w, "create series occurrence", err)
			return
		}
	}
	for _, ts := range moreStarts {
		p := params
		p.StartsAt = ts
		if params.EndsAt.Valid {
			p.EndsAt = pgtype.Timestamptz{Time: ts.Time.Add(params.EndsAt.Time.Sub(params.StartsAt.Time)), Valid: true}
		}
		if _, err := s.queries.CreateEvent(r.Context(), p); err != nil {
			s.internal(w, "create series occurrence", err)
			return
		}
	}
	// Re-poll: pull the people from a previous event (e.g. the series that just
	// ended) onto this one as invites, and email them - "the poll goes out".
	// Manager-only on the SOURCE event, so only its host/cohost can re-poll it.
	if in.InviteFrom != "" {
		srcID, ok := parseUUID(in.InviteFrom)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid invite_from"})
			return
		}
		src, role, rerr := s.eventAndRole(r.Context(), srcID, uid)
		if rerr != nil || !isManager(role) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "invite_from must be an event you host"})
			return
		}
		_ = src
		seen := map[string]bool{uid: true}
		if atts, aerr := s.queries.ListAttendees(r.Context(), srcID); aerr == nil {
			for _, a := range atts {
				seen[a.UserID] = false
			}
		}
		if invs, ierr := s.queries.ListEventInvites(r.Context(), srcID); ierr == nil {
			for _, i := range invs {
				if _, dup := seen[i.UserID]; !dup {
					seen[i.UserID] = false
				}
			}
		}
		invited := 0
		for userID, isSelf := range seen {
			if isSelf {
				continue
			}
			if err := s.queries.AddEventInvite(r.Context(), db.AddEventInviteParams{EventID: ev.ID, UserID: userID, InviterID: uid}); err == nil {
				s.notifyInvite(r.Context(), ev, uid, userID)
				invited++
			}
		}
		s.analytics.Capture(uid, "series_repolled", map[string]any{"event_id": uuidStr(ev.ID), "from": in.InviteFrom, "invited": invited})
	}
	for _, ts := range options {
		if _, err := s.queries.AddTimeOption(r.Context(), db.AddTimeOptionParams{EventID: ev.ID, StartsAt: ts}); err != nil {
			s.internal(w, "add time option", err)
			return
		}
	}
	s.analytics.Capture(uid, "event_created", map[string]any{
		"event_id":        uuidStr(ev.ID),
		"event_type":      ev.EventType,
		"location_mode":   ev.LocationMode,
		"scheduling_mode": ev.SchedulingMode,
		"status":          ev.Status,
		"time_options":    len(options),
		"recurrence":      in.Repeat,
		"occurrences":     in.RepeatCount,
	})
	writeJSON(w, http.StatusCreated, ev)
}

func (s *server) handleGetEvent(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, err := s.queries.GetEvent(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "get event", err)
		return
	}
	isHost := ev.HostID == uid
	role := "guest"
	if isHost {
		role = "host"
	} else if isCo, _ := s.queries.IsCohost(r.Context(), db.IsCohostParams{EventID: id, UserID: uid}); isCo {
		role = "cohost"
	}
	canManage := isManager(role)

	options, err := s.queries.ListTimeOptions(r.Context(), id)
	if err != nil {
		s.internal(w, "list options", err)
		return
	}
	votes, err := s.queries.ListVotesForEvent(r.Context(), id)
	if err != nil {
		s.internal(w, "list votes", err)
		return
	}
	generalVotes, err := s.queries.ListGeneralVotesForEvent(r.Context(), id)
	if err != nil {
		s.internal(w, "list general votes", err)
		return
	}
	attendees, err := s.queries.ListAttendees(r.Context(), id)
	if err != nil {
		s.internal(w, "list attendees", err)
		return
	}
	answers, err := s.queries.ListPreferenceAnswersForEvent(r.Context(), id)
	if err != nil {
		s.internal(w, "list answers", err)
		return
	}
	// Guests only see their own preference answers; managers see everyone's.
	if !canManage {
		filtered := answers[:0:0]
		for _, a := range answers {
			if a.UserID == uid {
				filtered = append(filtered, a)
			}
		}
		answers = filtered
	}

	comments, err := s.queries.ListEventComments(r.Context(), id)
	if err != nil {
		s.internal(w, "list comments", err)
		return
	}
	cohosts, err := s.queries.ListCohosts(r.Context(), id)
	if err != nil {
		s.internal(w, "list cohosts", err)
		return
	}
	invites, err := s.queries.ListEventInvites(r.Context(), id)
	if err != nil {
		s.internal(w, "list invites", err)
		return
	}
	// Sibling occurrences when this event is part of a recurring series.
	var series []db.ListSeriesEventsRow
	if ev.SeriesID.Valid {
		if series, err = s.queries.ListSeriesEvents(r.Context(), ev.SeriesID); err != nil {
			s.internal(w, "list series", err)
			return
		}
	}

	muted, _ := s.queries.IsEventMuted(r.Context(), db.IsEventMutedParams{EventID: id, UserID: uid})

	// Names for poll responders - a pure voter (availability filled, no RSVP)
	// has no attendee row, so the web can't label them from attendees alone.
	voterProfiles, _ := s.queries.ListVoterProfiles(r.Context(), id)

	// Best-time ranking input: for specific-time polls, score every option
	// against ALL attendees' saved availability (free/busy for that option's
	// day+daypart in the event's timezone) - not just the viewer's calendar.
	optionFit := map[string]map[string]int{}
	if ev.SchedulingMode == "poll" && len(options) > 0 {
		if rows, ferr := s.queries.ListAttendeeAvailabilityForEvent(r.Context(), id); ferr == nil && len(rows) > 0 {
			byCell := map[string]map[string]bool{} // "day:part" -> user -> isFree
			for _, row := range rows {
				k := row.Day.Time.Format("2006-01-02") + ":" + row.Daypart
				if byCell[k] == nil {
					byCell[k] = map[string]bool{}
				}
				byCell[k][row.UserID] = row.Status != "busy"
			}
			loc := eventLocation(ev)
			for _, o := range options {
				local := o.StartsAt.Time.In(loc)
				k := local.Format("2006-01-02") + ":" + hourToDaypart(local.Hour())
				fit := map[string]int{"free": 0, "busy": 0}
				for _, isFree := range byCell[k] {
					if isFree {
						fit["free"]++
					} else {
						fit["busy"]++
					}
				}
				optionFit[uuidStr(o.ID)] = fit
			}
		}
	}

	// Opening the event clears its "new" invite marker (per-event, persistent).
	_ = s.queries.MarkOneInviteSeen(r.Context(), db.MarkOneInviteSeenParams{EventID: id, UserID: uid})
	s.analytics.Capture(uid, "event_viewed", map[string]any{
		"event_id": uuidStr(ev.ID),
		"role":     role,
		"status":   ev.Status,
	})
	// Host identity for the invite hero ("Hosted by ...").
	hostName, hostAvatar := "", ""
	if hp, herr := s.queries.GetProfile(r.Context(), ev.HostID); herr == nil {
		hostName, hostAvatar = hp.DisplayName, hp.AvatarUrl
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"event":              ev,
		"host_name":          hostName,
		"host_avatar":        hostAvatar,
		"role":               role,
		"can_manage":         canManage,
		"viewer_id":          uid,
		"muted":              muted,
		"voters":             voterProfiles,
		"option_fit":         optionFit,
		"time_options":       options,
		"votes":              votes,
		"general_votes":      generalVotes,
		"attendees":          attendees,
		"preference_answers": answers,
		"comments":           comments,
		"cohosts":            cohosts,
		"invites":            invites,
		"series":             series,
	})
}

func (s *server) handleRsvp(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	var in struct {
		Rsvp string `json:"rsvp"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if !oneOf(in.Rsvp, "going", "maybe", "declined") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid rsvp"})
		return
	}
	ev, ok := s.requireActiveEvent(w, r, id)
	if !ok {
		return
	}
	// Capacity gate: a "going" beyond the cap becomes a waitlist spot instead
	// (unless this person already holds a going spot - re-confirming keeps it).
	waitlisted := false
	if in.Rsvp == "going" && ev.Capacity > 0 {
		going, cerr := s.queries.CountGoing(r.Context(), id)
		if cerr == nil && going >= ev.Capacity {
			if cur, gerr := s.queries.GetAttendee(r.Context(), db.GetAttendeeParams{EventID: id, UserID: uid}); gerr != nil || cur.Rsvp != "going" {
				in.Rsvp = "waitlist"
				waitlisted = true
			}
		}
	}
	// UpsertRsvp returns no row when the rsvp is unchanged (a re-submit) - treat
	// that as "nothing happened": don't re-notify the host. Only a genuine change
	// TO "going" emails the host, so double-clicks/reconfirms can't duplicate it.
	a, err := s.queries.UpsertRsvp(r.Context(), db.UpsertRsvpParams{EventID: id, UserID: uid, Rsvp: in.Rsvp})
	changed := true
	if errors.Is(err, pgx.ErrNoRows) {
		changed = false
		a, err = s.queries.GetAttendee(r.Context(), db.GetAttendeeParams{EventID: id, UserID: uid})
	}
	if err != nil {
		s.internal(w, "rsvp", err)
		return
	}
	s.analytics.Capture(uid, "rsvp_submitted", map[string]any{"event_id": r.PathValue("id"), "rsvp": in.Rsvp, "waitlisted": waitlisted})
	if in.Rsvp == "going" && changed && s.notify.Enabled() {
		if p, err := s.queries.GetProfile(r.Context(), uid); err == nil {
			s.notifyNewRSVP(r.Context(), ev, uid, p.DisplayName)
		}
	}
	// Someone stepping back from "going" can free a capped spot - promote the
	// oldest waitlisted person (and tell them).
	if changed && in.Rsvp != "going" && ev.Capacity > 0 {
		s.promoteFromWaitlist(r.Context(), ev)
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *server) handleVotes(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, active := s.requireActiveEvent(w, r, id)
	if !active {
		return
	}
	if pollClosed(ev) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this poll has closed"})
		return
	}
	var in struct {
		Votes []struct {
			OptionID string `json:"option_id"`
			Response string `json:"response"`
		} `json:"votes"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	// Only accept votes for options that belong to this event.
	options, err := s.queries.ListTimeOptions(r.Context(), id)
	if err != nil {
		s.internal(w, "list options", err)
		return
	}
	valid := map[[16]byte]bool{}
	for _, o := range options {
		if o.ID.Valid {
			valid[o.ID.Bytes] = true
		}
	}
	for _, v := range in.Votes {
		oid, ok := parseUUID(v.OptionID)
		if !ok || !valid[oid.Bytes] {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid option_id"})
			return
		}
		if !oneOf(v.Response, "yes", "no", "maybe") {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid response"})
			return
		}
		if _, err := s.queries.UpsertVote(r.Context(), db.UpsertVoteParams{OptionID: oid, UserID: uid, Response: v.Response}); err != nil {
			s.internal(w, "upsert vote", err)
			return
		}
	}
	s.analytics.Capture(uid, "poll_voted", map[string]any{"event_id": r.PathValue("id"), "votes": len(in.Votes)})
	s.maybeNotifyQuorum(r.Context(), ev)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleGeneralVotes saves a guest's availability for a general poll. What it
// accepts depends on the event's general_scope:
//
//	week    → day_slots: concrete date+daypart cells inside the event's week window
//	month   → days: concrete dates inside the event's month window
//	general → months (YYYY-MM) + slots (weekday×daypart) - the original shape
//
// The guest's whole set is replaced each save. Windows are anchored at the
// event's created_at so every attendee answers about the same dates.
func (s *server) handleGeneralVotes(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, active := s.requireActiveEvent(w, r, id)
	if !active {
		return
	}
	if pollClosed(ev) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this poll has closed"})
		return
	}
	var in struct {
		Months []string `json:"months"`
		Slots  []struct {
			Weekday int16  `json:"weekday"`
			Daypart string `json:"daypart"`
		} `json:"slots"`
		Days     []string `json:"days"` // YYYY-MM-DD (month scope)
		DaySlots []struct {
			Day     string `json:"day"` // YYYY-MM-DD (week scope)
			Daypart string `json:"daypart"`
		} `json:"day_slots"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}

	// A scoped date must fall inside the answer window: created_at .. +horizon
	// days (±1 day of timezone tolerance on each edge).
	inWindow := func(day string, horizon int) bool {
		t, err := time.Parse("2006-01-02", day)
		if err != nil {
			return false
		}
		start := ev.CreatedAt.Time.UTC().Truncate(24 * time.Hour)
		return !t.Before(start.AddDate(0, 0, -1)) && !t.After(start.AddDate(0, 0, horizon+1))
	}

	// Validate + flatten into (dimension, value) rows according to the scope.
	type vote struct{ dimension, value string }
	var rows []vote
	fail := func(msg string) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": msg})
	}
	switch ev.GeneralScope {
	case "week":
		if len(in.DaySlots) > 8*len(dayparts) {
			fail("too many selections")
			return
		}
		for _, dsl := range in.DaySlots {
			if !inWindow(dsl.Day, 7) || !oneOf(dsl.Daypart, dayparts...) {
				fail("invalid day slot")
				return
			}
			rows = append(rows, vote{"dayslot", dsl.Day + ":" + dsl.Daypart})
		}
	case "month":
		// Month scope is a dates × dayparts grid (28-day window). Plain day
		// votes remain accepted for events answered before the grid upgrade.
		if len(in.Days) > 32 || len(in.DaySlots) > 28*len(dayparts) {
			fail("too many selections")
			return
		}
		for _, d := range in.Days {
			if !inWindow(d, 28) {
				fail("invalid day")
				return
			}
			rows = append(rows, vote{"day", d})
		}
		for _, dsl := range in.DaySlots {
			if !inWindow(dsl.Day, 28) || !oneOf(dsl.Daypart, dayparts...) {
				fail("invalid day slot")
				return
			}
			rows = append(rows, vote{"dayslot", dsl.Day + ":" + dsl.Daypart})
		}
	default: // general
		if len(in.Months) > 24 || len(in.Slots) > 7*len(dayparts) {
			fail("too many selections")
			return
		}
		for _, m := range in.Months {
			if !validMonth(m) {
				fail("invalid month")
				return
			}
			rows = append(rows, vote{"month", m})
		}
		for _, sl := range in.Slots {
			if sl.Weekday < 0 || sl.Weekday > 6 || !oneOf(sl.Daypart, dayparts...) {
				fail("invalid slot")
				return
			}
			// value "<weekday>:<daypart>", e.g. "6:evening".
			rows = append(rows, vote{"slot", strconv.Itoa(int(sl.Weekday)) + ":" + sl.Daypart})
		}
	}

	if err := s.queries.ClearGeneralVotes(r.Context(), db.ClearGeneralVotesParams{EventID: id, UserID: uid}); err != nil {
		s.internal(w, "clear general votes", err)
		return
	}
	for _, v := range rows {
		if err := s.queries.AddGeneralVote(r.Context(), db.AddGeneralVoteParams{
			EventID: id, UserID: uid, Dimension: v.dimension, Value: v.value,
		}); err != nil {
			s.internal(w, "add general vote", err)
			return
		}
	}
	// Availability flows back: a concrete date+daypart pick on any poll also
	// marks that cell free in the guest's MAIN availability (a poll answer IS
	// an availability statement). Additive only - unpicked cells stay as they
	// were, and 'free' overwrites a stale busy. Fuzzy general-scope picks
	// (months / weekdays) don't map to concrete cells and are skipped.
	for _, v := range rows {
		if v.dimension != "dayslot" {
			continue
		}
		parts := strings.SplitN(v.value, ":", 2)
		if len(parts) != 2 {
			continue
		}
		d, derr := time.Parse("2006-01-02", parts[0])
		if derr != nil {
			continue
		}
		_ = s.queries.UpsertAvailabilityDayFree(r.Context(), db.UpsertAvailabilityDayFreeParams{
			UserID: uid, Day: pgtype.Date{Time: d, Valid: true}, Daypart: parts[1],
		})
	}
	s.analytics.Capture(uid, "general_voted", map[string]any{
		"event_id": r.PathValue("id"),
		"scope":    ev.GeneralScope,
		"picks":    len(rows),
	})
	s.maybeNotifyQuorum(r.Context(), ev)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handlePreferences(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if _, active := s.requireActiveEvent(w, r, id); !active {
		return
	}
	var in struct {
		Answers []struct {
			QuestionKey string `json:"question_key"`
			Answer      string `json:"answer"`
		} `json:"answers"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	for _, a := range in.Answers {
		key := strings.TrimSpace(a.QuestionKey)
		ans := strings.TrimSpace(a.Answer)
		if key == "" || len(key) > 60 || len(ans) > 400 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid answer"})
			return
		}
		if _, err := s.queries.UpsertPreferenceAnswer(r.Context(), db.UpsertPreferenceAnswerParams{
			EventID: id, UserID: uid, QuestionKey: key, Answer: ans,
		}); err != nil {
			s.internal(w, "upsert answer", err)
			return
		}
	}
	s.analytics.Capture(uid, "preferences_submitted", map[string]any{"event_id": r.PathValue("id"), "answers": len(in.Answers)})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleFinalize(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	var in struct {
		StartsAt   string   `json:"starts_at"`
		MoreStarts []string `json:"more_starts"` // optional: schedule SEVERAL winning dates from the poll
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	ts, valid := parseTS(in.StartsAt)
	if !valid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "valid starts_at required"})
		return
	}
	if timeInPast(ts) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
		return
	}
	if len(in.MoreStarts) > 11 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "at most 12 dates"})
		return
	}
	var extra []pgtype.Timestamptz
	for _, raw := range in.MoreStarts {
		ets, ok := parseTS(raw)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid extra date"})
			return
		}
		if timeInPast(ets) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
			return
		}
		extra = append(extra, ets)
	}
	// Host or cohost may finalize (cohosts help run the event).
	loaded, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "finalize: load event", err)
		return
	}
	if !isManager(role) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your event"})
		return
	}
	if loaded.Status == "cancelled" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "event is cancelled"})
		return
	}
	ev, err := s.queries.FinalizeEvent(r.Context(), db.FinalizeEventParams{ID: id, StartsAt: ts})
	if err != nil {
		s.internal(w, "finalize", err)
		return
	}
	// Multi-date finalize: the host picked SEVERAL winning dates off the group's
	// availability. The poll event becomes the first occurrence; each extra date
	// becomes a sibling in a new series with everyone (attendees + invites, RSVPs
	// intact) carried over.
	if len(extra) > 0 {
		series := newUUID()
		if err := s.queries.SetSeries(r.Context(), db.SetSeriesParams{ID: id, SeriesID: series, Recurrence: "custom"}); err != nil {
			s.internal(w, "finalize: set series", err)
			return
		}
		for _, ets := range extra {
			sib, cerr := s.queries.CreateEvent(r.Context(), db.CreateEventParams{
				HostID: ev.HostID, Title: ev.Title, EventType: ev.EventType, Description: ev.Description,
				LocationMode: ev.LocationMode, LocationAddress: ev.LocationAddress,
				SchedulingMode: "fixed", StartsAt: ets, Status: "scheduled",
				GroupID: ev.GroupID, SeriesID: series, Recurrence: "custom",
				Visibility: ev.Visibility, Topic: ev.Topic, City: ev.City,
				CustomEmoji: ev.CustomEmoji, CustomLabel: ev.CustomLabel,
				GeneralScope: ev.GeneralScope, Timezone: ev.Timezone,
			})
			if cerr != nil {
				s.internal(w, "finalize: create occurrence", cerr)
				return
			}
			_ = s.queries.CopyAttendees(r.Context(), db.CopyAttendeesParams{EventID: id, Column2: sib.ID})
			_ = s.queries.CopyInvites(r.Context(), db.CopyInvitesParams{EventID: id, Column2: sib.ID})
		}
	}
	s.analytics.Capture(uid, "event_finalized", map[string]any{"event_id": r.PathValue("id"), "dates": 1 + len(extra)})
	s.notifyFinalized(r.Context(), ev, extra)
	writeJSON(w, http.StatusOK, ev)
}

// =========================== friends ==============================

func (s *server) handleListFriends(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	friends, err := s.queries.ListFriends(r.Context(), uid)
	if err != nil {
		s.internal(w, "list friends", err)
		return
	}
	incoming, err := s.queries.ListIncomingRequests(r.Context(), uid)
	if err != nil {
		s.internal(w, "list incoming", err)
		return
	}
	outgoing, err := s.queries.ListOutgoingRequests(r.Context(), uid)
	if err != nil {
		s.internal(w, "list outgoing", err)
		return
	}
	suggestions, err := s.queries.ListPeopleYouMayKnow(r.Context(), uid)
	if err != nil {
		s.internal(w, "list suggestions", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"friends": friends, "incoming": incoming, "outgoing": outgoing, "suggestions": suggestions,
	})
}

func (s *server) handleAddFriend(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Handle string `json:"handle"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Handle = strings.ToLower(strings.TrimSpace(in.Handle))
	if in.Handle == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "handle is required"})
		return
	}
	target, err := s.queries.GetProfileByHandle(r.Context(), in.Handle)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no user with that handle"})
		return
	}
	if err != nil {
		s.internal(w, "get profile by handle", err)
		return
	}
	if target.UserID == uid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "you can't friend yourself"})
		return
	}
	f, err := s.queries.CreateFriendRequest(r.Context(), db.CreateFriendRequestParams{
		RequesterID: uid, AddresseeID: target.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// ON CONFLICT DO NOTHING -> request already exists; idempotent success.
		writeJSON(w, http.StatusOK, map[string]string{"status": "already_requested"})
		return
	}
	if err != nil {
		s.internal(w, "create friend request", err)
		return
	}
	s.analytics.Capture(uid, "friend_requested", map[string]any{})
	writeJSON(w, http.StatusCreated, f)
}

func (s *server) handleAcceptFriend(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	f, err := s.queries.AcceptFriendRequest(r.Context(), db.AcceptFriendRequestParams{ID: id, AddresseeID: uid})
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no pending request"})
		return
	}
	if err != nil {
		s.internal(w, "accept friend", err)
		return
	}
	s.analytics.Capture(uid, "friend_accepted", map[string]any{})
	writeJSON(w, http.StatusOK, f)
}

func (s *server) handleFriendAvailability(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	friendID := r.PathValue("id")
	ok, err := s.queries.AreFriends(r.Context(), db.AreFriendsParams{RequesterID: uid, AddresseeID: friendID})
	if err != nil {
		s.internal(w, "are friends", err)
		return
	}
	if !ok {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not friends"})
		return
	}
	days, err := s.queries.ListAvailabilityDays(r.Context(), friendID)
	if err != nil {
		s.internal(w, "friend availability", err)
		return
	}
	commitments, err := s.queries.ListUpcomingCommitments(r.Context(), friendID)
	if err != nil {
		s.internal(w, "friend commitments", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": formatDays(days), "commitments": commitments})
}
