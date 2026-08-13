package main

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/clsandbox/api/internal/db"
)

// public.go - the PUBLIC entity page: the read behind a bare /g/{id} share link.
//
// UNAUTHENTICATED and read-only (rate-limited like /api/discover). A signed-out
// visitor must be able to open a shared club link and see what it is without an
// account, so this endpoint publishes ONLY what a host chose to make public:
//
//	name, icon, description, member COUNT, follower COUNT, upcoming LISTED
//	events, and (V4) a BOUNDED (limit 10) recent-PAST list of the same LISTED,
//	non-cancelled events - social proof for a venue, never a private history.
//
// Never the member list, never unlisted/draft/cancelled events, never an
// email. Membership is NOT granted here (see handleJoinGroup) - the bare link
// buys a view, not a seat.
//
// The shape is deliberately entity-agnostic. A public GROUP page and the future
// public HOST page (/u/{handle}) are the same primitive - entity → upcoming
// listed events → follow state → OG unfurl - so the response is an `entity`
// envelope carrying its own `type`. Adding hosts later is a new loader + a new
// route, not a new shape.

type publicEntity struct {
	Type          string `json:"type"` // "group" today; "host" when /u/{handle} lands
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Emoji         string `json:"emoji"`
	IconURL       string `json:"icon_url"`
	MemberCount   int32  `json:"member_count"`
	FollowerCount int32  `json:"follower_count"`
}

// publicViewer is everything about the CALLER. All zero for a signed-out
// visitor - the page itself never depends on it.
type publicViewer struct {
	ID          string `json:"id"`
	IsMember    bool   `json:"is_member"`
	IsFollowing bool   `json:"is_following"`
	// CanJoin: a live invite token was presented (?invite=…), so the page shows
	// the "Join this group" CTA. The button is UI only - the join endpoint
	// re-verifies the token itself.
	CanJoin bool `json:"can_join"`
}

type publicPage struct {
	Entity     publicEntity `json:"entity"`
	Events     []db.Event   `json:"events"`
	PastEvents []db.Event   `json:"past_events"`
	Viewer     publicViewer `json:"viewer"`
}

// handleGroupPublicPage: GET /api/public/groups/{id} (optional auth).
func (s *server) handleGroupPublicPage(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context()) // "" when signed out
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	g, err := s.queries.GetGroup(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "public group page", err)
		return
	}
	ctx := r.Context()
	var (
		count         int32
		events        []db.Event
		pastEvents    []db.Event
		followerCount int32
		member        bool
		following     bool
		canJoin       bool
	)
	// Independent reads - fan out (the DB is a network hop away).
	if perr := parallel(
		func() (e error) { count, e = s.queries.CountGroupMembers(ctx, id); return },
		func() (e error) { events, e = s.queries.ListGroupListedEvents(ctx, id); return },
		func() (e error) { pastEvents, e = s.queries.ListGroupPastListedEvents(ctx, id); return },
		func() (e error) {
			followerCount, e = s.queries.CountFollowersOf(ctx, db.CountFollowersOfParams{Kind: "group", Value: uuidStr(id)})
			return
		},
		func() error {
			if uid == "" {
				return nil
			}
			member, _ = s.queries.IsGroupMember(ctx, db.IsGroupMemberParams{ID: id, UserID: uid})
			return nil
		},
		func() error {
			// You can FOLLOW a club without joining it - this page is where a
			// non-member makes that choice, so it needs the current state.
			if uid == "" {
				return nil
			}
			following, _ = s.queries.IsFollowing(ctx, db.IsFollowingParams{UserID: uid, Kind: "group", Value: uuidStr(id)})
			return nil
		},
		func() error {
			canJoin = s.validGroupInvite(ctx, id, r.URL.Query().Get("invite"))
			return nil
		},
	); perr != nil {
		s.internal(w, "public group page: load", perr)
		return
	}
	if events == nil {
		events = []db.Event{}
	}
	if pastEvents == nil {
		pastEvents = []db.Event{}
	}
	// Capture page view for signed-in users only (anonymous visitors have uid="")
	if uid != "" {
		s.analytics.Capture(uid, "public_page_served", map[string]any{"group_id": uuidStr(id), "signed_in": true})
	}
	writeJSON(w, http.StatusOK, publicPage{
		Entity: publicEntity{
			Type: "group", ID: uuidStr(g.ID), Name: g.Name, Description: g.Description,
			Emoji: g.Emoji, IconURL: g.IconUrl, MemberCount: count, FollowerCount: followerCount,
		},
		Events:     events,
		PastEvents: pastEvents,
		Viewer:     publicViewer{ID: uid, IsMember: member, IsFollowing: following, CanJoin: canJoin && !member},
	})
}
