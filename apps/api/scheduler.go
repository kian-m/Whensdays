package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// scheduler.go holds the "get-togethers" feature: profiles, general
// availability, friends, and events (with availability polls + per-event-type
// preference questions). Every handler scopes its writes/reads to the
// authenticated user (userIDFrom) — never a user id from the request body.

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

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(dst); err != nil {
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
	if in.DisplayName == "" || in.Handle == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "display_name and handle are required"})
		return
	}
	if len(in.DisplayName) > 80 || len(in.Handle) > 40 || !validHandle(in.Handle) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "handle must be 1-40 chars: a-z, 0-9, _ or -"})
		return
	}
	p, err := s.queries.UpsertProfile(r.Context(), db.UpsertProfileParams{
		UserID: uid, DisplayName: in.DisplayName, Handle: in.Handle,
	})
	if isUniqueViolation(err) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "handle already taken"})
		return
	}
	if err != nil {
		s.internal(w, "upsert profile", err)
		return
	}
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
		} `json:"slots"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	for _, sl := range in.Slots {
		if sl.Weekday < 0 || sl.Weekday > 6 || !oneOf(sl.PartOfDay, "morning", "afternoon", "evening") {
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
			UserID: uid, Weekday: sl.Weekday, PartOfDay: sl.PartOfDay,
		}); err != nil {
			s.internal(w, "add availability", err)
			return
		}
	}
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
	attending, err := s.queries.ListEventsAttending(r.Context(), uid)
	if err != nil {
		s.internal(w, "list attending", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hosting": hosting, "attending": attending})
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
		TimeOptions     []string `json:"time_options"`  // RFC3339[], for poll mode
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
	if !oneOf(in.EventType, "dinner", "drinks", "movie", "trivia", "party", "other") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid event_type"})
		return
	}
	if !oneOf(in.LocationMode, "host_place", "find_venue") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid location_mode"})
		return
	}
	if !oneOf(in.SchedulingMode, "fixed", "poll") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid scheduling_mode"})
		return
	}

	params := db.CreateEventParams{
		HostID: uid, Title: in.Title, EventType: in.EventType, Description: in.Description,
		LocationMode: in.LocationMode, LocationAddress: in.LocationAddress, SchedulingMode: in.SchedulingMode,
	}
	var options []pgtype.Timestamptz
	if in.SchedulingMode == "fixed" {
		ts, ok := parseTS(in.StartsAt)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "fixed events need a valid starts_at"})
			return
		}
		params.StartsAt = ts
		params.Status = "scheduled"
	} else {
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
	}

	ev, err := s.queries.CreateEvent(r.Context(), params)
	if err != nil {
		s.internal(w, "create event", err)
		return
	}
	for _, ts := range options {
		if _, err := s.queries.AddTimeOption(r.Context(), db.AddTimeOptionParams{EventID: ev.ID, StartsAt: ts}); err != nil {
			s.internal(w, "add time option", err)
			return
		}
	}
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
	// Guests only see their own preference answers; the host sees everyone's.
	if !isHost {
		filtered := answers[:0:0]
		for _, a := range answers {
			if a.UserID == uid {
				filtered = append(filtered, a)
			}
		}
		answers = filtered
	}

	role := "guest"
	if isHost {
		role = "host"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"event":              ev,
		"role":               role,
		"viewer_id":          uid,
		"time_options":       options,
		"votes":              votes,
		"attendees":          attendees,
		"preference_answers": answers,
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
	a, err := s.queries.UpsertRsvp(r.Context(), db.UpsertRsvpParams{EventID: id, UserID: uid, Rsvp: in.Rsvp})
	if err != nil {
		s.internal(w, "rsvp", err)
		return
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handlePreferences(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
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
		StartsAt string `json:"starts_at"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	ts, valid := parseTS(in.StartsAt)
	if !valid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "valid starts_at required"})
		return
	}
	ev, err := s.queries.FinalizeEvent(r.Context(), db.FinalizeEventParams{ID: id, HostID: uid, StartsAt: ts})
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the event doesn't exist or the caller isn't the host.
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your event"})
		return
	}
	if err != nil {
		s.internal(w, "finalize", err)
		return
	}
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
	writeJSON(w, http.StatusOK, map[string]any{"friends": friends, "incoming": incoming, "outgoing": outgoing})
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
	slots, err := s.queries.ListAvailability(r.Context(), friendID)
	if err != nil {
		s.internal(w, "friend availability", err)
		return
	}
	commitments, err := s.queries.ListUpcomingCommitments(r.Context(), friendID)
	if err != nil {
		s.internal(w, "friend commitments", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slots": slots, "commitments": commitments})
}
