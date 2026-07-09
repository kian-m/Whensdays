package main

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// comments.go adds an event comment thread plus host-delegated cohosts.
//
// Roles on an event:
//   host   - events.host_id. Can do everything: edit, finalize, moderate
//            comments, toggle comments on/off, and add/remove cohosts.
//   cohost - a row in event_cohosts. A "manager": can edit + finalize the event,
//            share the invite link (sees the host view), and moderate comments.
//            Cannot manage cohosts or toggle the thread.
//   guest  - anyone else with the invite link. Can read and (if comments are
//            enabled) post comments, and delete their own comments.

const maxCommentLen = 2000

// eventAndRole loads an event and the caller's role: "host", "cohost", or "guest".
func (s *server) eventAndRole(ctx context.Context, id pgtype.UUID, uid string) (db.Event, string, error) {
	ev, err := s.queries.GetEvent(ctx, id)
	if err != nil {
		return ev, "", err
	}
	if ev.HostID == uid {
		return ev, "host", nil
	}
	isCo, err := s.queries.IsCohost(ctx, db.IsCohostParams{EventID: id, UserID: uid})
	if err != nil {
		return ev, "", err
	}
	if isCo {
		return ev, "cohost", nil
	}
	return ev, "guest", nil
}

// isManager reports whether a role may run the event (host or cohost).
func isManager(role string) bool { return role == "host" || role == "cohost" }

func (s *server) handlePostComment(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, _, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "comment: load event", err)
		return
	}
	if !ev.CommentsEnabled {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "comments are turned off for this event"})
		return
	}
	var in struct {
		Body   string `json:"body"`
		GifUrl string `json:"gif_url"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if !validGifURL(in.GifUrl) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "gif must come from the picker"})
		return
	}
	if in.Body == "" && in.GifUrl == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "comment is required"})
		return
	}
	if len(in.Body) > maxCommentLen {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "comment too long"})
		return
	}
	c, err := s.queries.AddEventComment(r.Context(), db.AddEventCommentParams{EventID: id, UserID: uid, Body: in.Body, GifUrl: in.GifUrl})
	if err != nil {
		s.internal(w, "add comment", err)
		return
	}
	s.analytics.Capture(uid, "comment_posted", map[string]any{"event_id": r.PathValue("id")})
	if p, perr := s.queries.GetProfile(r.Context(), uid); perr == nil {
		note := in.Body
		if note == "" {
			note = "sent a GIF"
		}
		s.notifyNewComment(r.Context(), ev, uid, p.DisplayName, note)
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *server) handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	cid, ok2 := parseUUID(r.PathValue("commentId"))
	if !ok || !ok2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	_, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "delete comment: load event", err)
		return
	}
	c, err := s.queries.GetEventComment(r.Context(), cid)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && c.EventID != id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "get comment", err)
		return
	}
	// The author can delete their own; a manager (host/cohost) can moderate any.
	if c.UserID != uid && !isManager(role) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not allowed"})
		return
	}
	if err := s.queries.DeleteEventComment(r.Context(), cid); err != nil {
		s.internal(w, "delete comment", err)
		return
	}
	s.analytics.Capture(uid, "comment_deleted", map[string]any{"event_id": r.PathValue("id"), "moderated": c.UserID != uid})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleSetCommentsEnabled turns the thread on/off - host only.
func (s *server) handleSetCommentsEnabled(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	_, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "comments toggle: load event", err)
		return
	}
	if role != "host" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "host only"})
		return
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.queries.SetCommentsEnabled(r.Context(), db.SetCommentsEnabledParams{ID: id, CommentsEnabled: in.Enabled}); err != nil {
		s.internal(w, "set comments enabled", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"comments_enabled": in.Enabled})
}

// handleAddCohost delegates to another user by handle - host only.
func (s *server) handleAddCohost(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	_, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "add cohost: load event", err)
		return
	}
	if role != "host" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "host only"})
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
		s.internal(w, "lookup cohost", err)
		return
	}
	if prof.UserID == uid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "you're already the host"})
		return
	}
	if err := s.queries.AddCohost(r.Context(), db.AddCohostParams{EventID: id, UserID: prof.UserID}); err != nil {
		s.internal(w, "add cohost", err)
		return
	}
	s.analytics.Capture(uid, "cohost_added", map[string]any{"event_id": r.PathValue("id")})
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

func (s *server) handleRemoveCohost(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	_, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "remove cohost: load event", err)
		return
	}
	if role != "host" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "host only"})
		return
	}
	if err := s.queries.RemoveCohost(r.Context(), db.RemoveCohostParams{EventID: id, UserID: r.PathValue("userId")}); err != nil {
		s.internal(w, "remove cohost", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleUpdateEvent edits an event's details - host or cohost.
func (s *server) handleUpdateEvent(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	current, role, err := s.eventAndRole(r.Context(), id, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "update event: load", err)
		return
	}
	if !isManager(role) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not allowed"})
		return
	}
	var in struct {
		Title           string     `json:"title"`
		Description     string     `json:"description"`
		LocationMode    string     `json:"location_mode"`
		LocationAddress string     `json:"location_address"`
		Visibility      string     `json:"visibility"` // optional: keep current when empty
		Topic           string     `json:"topic"`
		City            string     `json:"city"`
		PhotoUrl        string     `json:"photo_url"`
		Theme           string     `json:"theme"`
		StartsAt        string     `json:"starts_at"`    // optional: reschedule a fixed/finalized time
		EndsAt          string     `json:"ends_at"`      // optional end time ("" clears it)
		ApplySeries     bool       `json:"apply_series"` // optional: copy content edits to every occurrence
		SeriesTimes     []struct { // optional: retime sibling occurrences (id must share this series)
			ID       string `json:"id"`
			StartsAt string `json:"starts_at"`
		} `json:"series_times"`
		AddStarts []string `json:"add_starts"` // optional: add MORE dates - grows a lone event into a series
	}
	// Covers ride in as data URLs, so this endpoint gets a larger body cap.
	if !decodeJSONLimit(w, r, &in, coverMaxBody) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "title is required"})
		return
	}
	if !oneOf(in.LocationMode, "host_place", "find_venue") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid location"})
		return
	}
	// Visibility is editable too (empty = keep). Non-public events carry no
	// discovery metadata so stale topic/city can't leak later.
	in.Topic = strings.ToLower(strings.TrimSpace(in.Topic))
	in.City = strings.TrimSpace(in.City)
	if in.Visibility == "" {
		in.Visibility = current.Visibility
	}
	if err := validatePublicFields(in.Visibility, in.Topic, in.City); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if in.Visibility != "public" {
		in.Topic, in.City = "", ""
	}
	if !validEventTheme(in.Theme) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid theme"})
		return
	}
	if !validCoverURL(in.PhotoUrl) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "cover must be an uploaded image or a Klipy gif"})
		return
	}
	// The time stays editable after finalize - but only for events that already
	// have a concrete time (fixed or finalized). A poll still in progress decides
	// its time through voting/finalize, not this field. Rescheduling resets
	// reminder_sent so the day-before reminder re-fires for the new date.
	startsAt := current.StartsAt
	reminderSent := current.ReminderSent
	endsAt := current.EndsAt
	if in.StartsAt != "" && current.StartsAt.Valid {
		ts, valid := parseTS(in.StartsAt)
		if !valid {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "valid starts_at required"})
			return
		}
		if !ts.Time.Equal(current.StartsAt.Time) {
			if timeInPast(ts) {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
				return
			}
			startsAt = ts
			reminderSent = false
		}
	}
	// End time: "" clears it; otherwise it must land after the (possibly new) start.
	if in.EndsAt == "" {
		endsAt = pgtype.Timestamptz{}
	} else {
		ets, eok := parseTS(in.EndsAt)
		if !eok || (startsAt.Valid && !ets.Time.After(startsAt.Time)) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "end time must be after the start"})
			return
		}
		endsAt = ets
	}
	// Added occurrences: parse/validate BEFORE any write so a bad date can't
	// half-apply the edit. Only an event with a concrete time can grow into a
	// series - a poll still decides its time by voting.
	var addStarts []pgtype.Timestamptz
	if len(in.AddStarts) > 0 {
		if len(in.AddStarts) > 11 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "at most 12 added dates"})
			return
		}
		if current.Status != "scheduled" || !current.StartsAt.Valid {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "dates can be added once the event is scheduled"})
			return
		}
		for _, raw := range in.AddStarts {
			ats, aok := parseTS(raw)
			if !aok {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid added date"})
				return
			}
			if timeInPast(ats) {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
				return
			}
			addStarts = append(addStarts, ats)
		}
	}
	ev, err := s.queries.UpdateEvent(r.Context(), db.UpdateEventParams{
		ID: id, Title: in.Title, Description: in.Description,
		LocationMode: in.LocationMode, LocationAddress: in.LocationAddress,
		Visibility: in.Visibility, Topic: in.Topic, City: in.City,
		PhotoUrl: in.PhotoUrl, Theme: in.Theme,
		StartsAt: startsAt, ReminderSent: reminderSent, EndsAt: endsAt,
	})
	if err != nil {
		s.internal(w, "update event", err)
		return
	}
	// Series editing (edit one vs ALL): with apply_series, copy the CONTENT
	// fields to every sibling occurrence. Each keeps its own starts_at and
	// reminder state - only this event's time was (possibly) rescheduled above.
	if in.ApplySeries && current.SeriesID.Valid {
		if sibs, serr := s.queries.ListSeriesEvents(r.Context(), current.SeriesID); serr == nil {
			for _, sib := range sibs {
				if sib.ID == id {
					continue
				}
				full, gerr := s.queries.GetEvent(r.Context(), sib.ID)
				if gerr != nil {
					continue
				}
				_, _ = s.queries.UpdateEvent(r.Context(), db.UpdateEventParams{
					ID: sib.ID, Title: in.Title, Description: in.Description,
					LocationMode: in.LocationMode, LocationAddress: in.LocationAddress,
					Visibility: in.Visibility, Topic: in.Topic, City: in.City,
					PhotoUrl: in.PhotoUrl, Theme: in.Theme,
					StartsAt: full.StartsAt, ReminderSent: full.ReminderSent, EndsAt: full.EndsAt,
				})
			}
		}
	}
	// Retime sibling occurrences (the edit form shows one time input per date).
	// Each id must belong to THIS event's series; content is preserved (only the
	// time moves), and a genuine change re-arms that occurrence's reminder.
	for _, st := range in.SeriesTimes {
		sibID, ok := parseUUID(st.ID)
		if !ok {
			continue
		}
		sib, gerr := s.queries.GetEvent(r.Context(), sibID)
		if gerr != nil || !current.SeriesID.Valid || sib.SeriesID != current.SeriesID || sibID == id {
			continue
		}
		ts, tok := parseTS(st.StartsAt)
		if !tok || !sib.StartsAt.Valid || ts.Time.Equal(sib.StartsAt.Time) {
			continue
		}
		if timeInPast(ts) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "events can't start in the past"})
			return
		}
		sibEnd := sib.EndsAt
		if sib.EndsAt.Valid && sib.StartsAt.Valid {
			sibEnd = pgtype.Timestamptz{Time: ts.Time.Add(sib.EndsAt.Time.Sub(sib.StartsAt.Time)), Valid: true}
		}
		_, _ = s.queries.UpdateEvent(r.Context(), db.UpdateEventParams{
			ID: sibID, Title: sib.Title, Description: sib.Description,
			LocationMode: sib.LocationMode, LocationAddress: sib.LocationAddress,
			Visibility: sib.Visibility, Topic: sib.Topic, City: sib.City,
			PhotoUrl: sib.PhotoUrl, Theme: sib.Theme,
			StartsAt: ts, ReminderSent: false, EndsAt: sibEnd,
		})
	}
	// Grow the series: each added date becomes a sibling occurrence carrying
	// this event's (just-updated) content - cover/theme included - and everyone
	// on it, RSVPs intact (same machinery as multi-date finalize). A lone event
	// gets a fresh series id first; an existing series keeps its own.
	if len(addStarts) > 0 {
		series := current.SeriesID
		if !series.Valid {
			series = newUUID()
			if serr := s.queries.SetSeries(r.Context(), db.SetSeriesParams{ID: id, SeriesID: series, Recurrence: "custom"}); serr != nil {
				s.internal(w, "update event: set series", serr)
				return
			}
		}
		for _, ats := range addStarts {
			sibEnd := pgtype.Timestamptz{}
			if ev.EndsAt.Valid && ev.StartsAt.Valid {
				sibEnd = pgtype.Timestamptz{Time: ats.Time.Add(ev.EndsAt.Time.Sub(ev.StartsAt.Time)), Valid: true}
			}
			sib, cerr := s.queries.CreateEvent(r.Context(), db.CreateEventParams{
				HostID: ev.HostID, Title: ev.Title, EventType: ev.EventType, Description: ev.Description,
				LocationMode: ev.LocationMode, LocationAddress: ev.LocationAddress,
				SchedulingMode: "fixed", StartsAt: ats, Status: "scheduled",
				GroupID: ev.GroupID, SeriesID: series, Recurrence: "custom",
				Visibility: ev.Visibility, Topic: ev.Topic, City: ev.City,
				CustomEmoji: ev.CustomEmoji, CustomLabel: ev.CustomLabel,
				GeneralScope: ev.GeneralScope, Timezone: ev.Timezone, EndsAt: sibEnd,
			})
			if cerr != nil {
				s.internal(w, "update event: add occurrence", cerr)
				return
			}
			// CreateEvent has no cover/theme columns - carry them separately.
			_, _ = s.queries.UpdateEvent(r.Context(), db.UpdateEventParams{
				ID: sib.ID, Title: ev.Title, Description: ev.Description,
				LocationMode: ev.LocationMode, LocationAddress: ev.LocationAddress,
				Visibility: ev.Visibility, Topic: ev.Topic, City: ev.City,
				PhotoUrl: ev.PhotoUrl, Theme: ev.Theme,
				StartsAt: ats, ReminderSent: false, EndsAt: sibEnd,
			})
			_ = s.queries.CopyAttendees(r.Context(), db.CopyAttendeesParams{EventID: id, Column2: sib.ID})
			_ = s.queries.CopyInvites(r.Context(), db.CopyInvitesParams{EventID: id, Column2: sib.ID})
		}
	}
	s.analytics.Capture(uid, "event_edited", map[string]any{"event_id": r.PathValue("id"), "role": role, "series": in.ApplySeries, "added_dates": len(addStarts)})
	writeJSON(w, http.StatusOK, ev)
}
