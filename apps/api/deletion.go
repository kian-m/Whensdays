package main

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// deletion.go - destructive actions, all soft where it matters:
//   events   → cancelled (status flip; lists already exclude cancelled, the
//              invite link keeps working so guests see "Cancelled" not a 404)
//   groups   → hard delete (members cascade; events keep living, group_id nulls)
//   friends  → hard delete of the friendship row (covers declining an incoming
//              request, cancelling an outgoing one, and unfriending)

// handleCancelEvent cancels an event (host only - more destructive than the
// edit/finalize powers cohosts get). ?series=all cancels every occurrence.
func (s *server) handleCancelEvent(w http.ResponseWriter, r *http.Request) {
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
		s.internal(w, "cancel: load event", err)
		return
	}
	if role != "host" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "host only"})
		return
	}
	wholeSeries := r.URL.Query().Get("series") == "all" && ev.SeriesID.Valid
	// Email going, unmuted attendees before flipping status. For a whole-series
	// cancel, each occurrence has its OWN attendee list - union them (deduped by
	// user). Sent per-recipient so each carries its own one-click mute link.
	if s.notify.Enabled() {
		seen := map[string]bool{}
		var contacts []db.ListGoingAttendeeContactsRow
		collect := func(id pgtype.UUID) {
			if cs, err := s.queries.ListGoingAttendeeContacts(r.Context(), id); err == nil {
				for _, c := range cs {
					if !seen[c.UserID] {
						seen[c.UserID] = true
						contacts = append(contacts, c)
					}
				}
			}
		}
		if wholeSeries {
			if occs, err := s.queries.ListSeriesEvents(r.Context(), ev.SeriesID); err == nil {
				for _, o := range occs {
					collect(o.ID)
				}
			}
		} else {
			collect(ev.ID)
		}
		for _, c := range contacts {
			body := renderEmail(emailContent{
				preheader: "This plan was called off.",
				heading:   ev.Title + " was cancelled",
				lines:     []string{"The host called this one off. No action needed - check the event page for any follow-up."},
				ctaLabel:  "View the event →",
				ctaURL:    campaignURL(s.eventURL(ev.ID), "cancelled"),
				logoURL:   s.logoURL(),
				unsubURL:  s.muteLink(c.UserID, uuidStr(ev.ID)),
				coverURL:  eventCover(ev),
				theme:     ev.Theme,
			})
			s.notify.Send([]string{c.Email}, "Cancelled: "+ev.Title, body)
		}
	}
	if wholeSeries {
		if err := s.queries.CancelSeries(r.Context(), ev.SeriesID); err != nil {
			s.internal(w, "cancel series", err)
			return
		}
	} else {
		if _, err := s.queries.CancelEvent(r.Context(), id); err != nil {
			s.internal(w, "cancel event", err)
			return
		}
	}
	s.analytics.Capture(uid, "event_cancelled", map[string]any{"event_id": r.PathValue("id"), "series": wholeSeries})
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

// handleDeleteGroup removes a group entirely - owner only. Its events survive
// (group_id nulls out); memberships cascade away.
func (s *server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	if g.OwnerID != uid {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner only"})
		return
	}
	if err := s.queries.DeleteGroup(r.Context(), db.DeleteGroupParams{ID: g.ID, OwnerID: uid}); err != nil {
		s.internal(w, "delete group", err)
		return
	}
	s.analytics.Capture(uid, "group_deleted", map[string]any{"group_id": uuidStr(g.ID)})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleDeleteFriendship deletes a friendship row by id. Either party may do
// it: the addressee declining a request, the requester cancelling one, or
// either side unfriending later.
func (s *server) handleDeleteFriendship(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	f, err := s.queries.GetFriendship(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "get friendship", err)
		return
	}
	if f.RequesterID != uid && f.AddresseeID != uid {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your friendship"})
		return
	}
	if err := s.queries.DeleteFriendship(r.Context(), id); err != nil {
		s.internal(w, "delete friendship", err)
		return
	}
	s.analytics.Capture(uid, "friendship_removed", map[string]any{"was_pending": f.Status == "pending"})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
