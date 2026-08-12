package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// validEmoji accepts a short emoji (incl. multi-rune ZWJ sequences) and rejects
// arbitrary text: no letters, digits, or spaces, max 16 runes.
func validEmoji(s string) bool {
	if s == "" || utf8.RuneCountInString(s) > 16 {
		return false
	}
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSpace(r) || r < 0x80 {
			return false
		}
	}
	return true
}

// groups.go - recurring groups (the product wedge): a persistent circle that
// plans together. Owner manages members; any member sees the group and can
// attach events to it. Access is membership-gated, not link-capability.
//
// TWO LINKS off one group (see public.go for the read side):
//
//	/g/{id}                  public page: name, icon, description, upcoming
//	                         LISTED events, Follow. No members, no join.
//	/g/{id}?invite=<token>   the same page PLUS "Join this group".
//
// Membership is not cosmetic (members see the member list and ALL the group's
// events), so joining requires the signed token - the bare id is NOT a join
// capability. Share-attribution (?from=<uid>, "who invited you") is orthogonal:
// it names an inviter in the unfurl and authorizes nothing.

// --- the join token ---
//
// Same envelope as every other capability link (mute|, rsvp|, icsfeed|), with
// its own "group|" payload namespace so no other token can be replayed here.
// The group's invite_token_version (migration 0045) is signed in and checked
// against the CURRENT row on every verify: bumping it revokes that ONE group's
// outstanding links. Signing over the bare key alone would make revocation mean
// rotating GUEST_TOKEN_KEY, which would kill every guest session, unsubscribe
// link, one-tap RSVP link and .ics feed at the same time.
func (g guestSigner) signGroupInvite(groupID string, version int32) string {
	return hmacSeal(g.key, "group|"+groupID+"|"+strconv.Itoa(int(version)))
}

func (g guestSigner) verifyGroupInvite(token string) (groupID string, version int32, ok bool) {
	payload, ok := hmacOpen(g.key, token)
	if !ok {
		return "", 0, false
	}
	parts := strings.Split(string(payload), "|")
	if len(parts) != 3 || parts[0] != "group" || parts[1] == "" {
		return "", 0, false
	}
	v, err := strconv.Atoi(parts[2])
	if err != nil || v < 1 {
		return "", 0, false
	}
	return parts[1], int32(v), true
}

// groupInviteToken mints the current invite token for a group.
func (s *server) groupInviteToken(ctx context.Context, id pgtype.UUID) string {
	v, err := s.queries.GetGroupInviteVersion(ctx, id)
	if err != nil {
		return ""
	}
	return s.guests.signGroupInvite(uuidStr(id), v)
}

// validGroupInvite reports whether token is a live invite for this group: right
// namespace, right group, and the group's CURRENT version (a regenerate bumps
// the version, so every older token stops verifying).
func (s *server) validGroupInvite(ctx context.Context, id pgtype.UUID, token string) bool {
	if token == "" {
		return false
	}
	gid, version, ok := s.guests.verifyGroupInvite(token)
	if !ok || gid != uuidStr(id) {
		return false
	}
	current, err := s.queries.GetGroupInviteVersion(ctx, id)
	return err == nil && current == version
}

// handleRotateGroupInvite regenerates the group's invite link (owner/admin).
// Irreversible for links already shared - the web arms it behind a two-tap
// confirm.
func (s *server) handleRotateGroupInvite(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	isAdmin, _ := s.queries.IsGroupAdmin(r.Context(), db.IsGroupAdminParams{ID: g.ID, UserID: uid})
	if !isAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admins only"})
		return
	}
	v, err := s.queries.BumpGroupInviteVersion(r.Context(), g.ID)
	if err != nil {
		s.internal(w, "rotate group invite", err)
		return
	}
	s.analytics.Capture(uid, "group_invite_rotated", map[string]any{"group_id": uuidStr(g.ID)})
	writeJSON(w, http.StatusOK, map[string]string{"invite_token": s.guests.signGroupInvite(uuidStr(g.ID), v)})
}

func (s *server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Emoji       string `json:"emoji"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	if in.Name == "" || len(in.Name) > 80 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name is required (max 80)"})
		return
	}
	if len(in.Description) > 500 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "description: max 500 characters"})
		return
	}
	if in.Emoji == "" {
		in.Emoji = "👥"
	} else if !validEmoji(in.Emoji) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "icon must be an emoji"})
		return
	}
	g, err := s.queries.CreateGroup(r.Context(), db.CreateGroupParams{OwnerID: uid, Name: in.Name, Description: in.Description, Emoji: in.Emoji})
	if err != nil {
		s.internal(w, "create group", err)
		return
	}
	s.analytics.Capture(uid, "group_created", map[string]any{"group_id": uuidStr(g.ID)})
	writeJSON(w, http.StatusCreated, g)
}

func (s *server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	gs, err := s.queries.ListMyGroups(r.Context(), uid)
	if err != nil {
		s.internal(w, "list groups", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": gs})
}

// loadGroupForMember returns the group iff the caller is owner or member.
func (s *server) loadGroupForMember(w http.ResponseWriter, r *http.Request) (db.Group, bool) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return db.Group{}, false
	}
	g, err := s.queries.GetGroup(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return db.Group{}, false
	}
	if err != nil {
		s.internal(w, "get group", err)
		return db.Group{}, false
	}
	member, err := s.queries.IsGroupMember(r.Context(), db.IsGroupMemberParams{ID: id, UserID: uid})
	if err != nil || !member {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member"})
		return db.Group{}, false
	}
	return g, true
}

func (s *server) handleGetGroup(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	// Three independent reads - fan out (the DB is a network hop away).
	ctx := r.Context()
	var (
		members     []db.ListGroupMembersRow
		events      []db.Event
		isAdmin     bool
		following   bool
		inviteToken string
	)
	err := parallel(
		func() (e error) { members, e = s.queries.ListGroupMembers(ctx, g.ID); return },
		func() (e error) { events, e = s.queries.ListGroupEvents(ctx, g.ID); return },
		func() error { isAdmin, _ = s.queries.IsGroupAdmin(ctx, db.IsGroupAdminParams{ID: g.ID, UserID: uid}); return nil },
		// Any member can grow the group, so any member gets the invite token
		// (this endpoint is already member-gated). Regenerating it is admin-only.
		func() error { inviteToken = s.groupInviteToken(ctx, g.ID); return nil },
		func() error {
			// Following a group is separate from belonging to it: members can
			// follow too (their listed events then ride the feed).
			following, _ = s.queries.IsFollowing(ctx, db.IsFollowingParams{UserID: uid, Kind: "group", Value: uuidStr(g.ID)})
			return nil
		},
	)
	if err != nil {
		s.internal(w, "group detail: load", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"group": g, "members": members, "events": events,
		"is_owner": g.OwnerID == uid, "is_admin": isAdmin, "viewer_id": uid,
		"is_following": following, "invite_token": inviteToken,
	})
}

// handleJoinGroup grants MEMBERSHIP, so it demands the signed invite token -
// the bare group id only ever buys the public page (see public.go). Guests can
// still join (they're real low-privilege users), they just need the invite
// link. The token rides in the BODY, not the query: a join is a write, and the
// body keeps the capability out of access logs and Referer headers.
func (s *server) handleJoinGroup(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if _, err := s.queries.GetGroup(r.Context(), id); errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	} else if err != nil {
		s.internal(w, "join group: load", err)
		return
	}
	var in struct {
		Invite string `json:"invite"`
	}
	// A bodyless POST is a TOKENLESS join, not a malformed request - fall
	// through to the 403 so the refusal says what's actually wrong.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// Already in (owner included): idempotent no-op, no token needed.
	if member, _ := s.queries.IsGroupMember(r.Context(), db.IsGroupMemberParams{ID: id, UserID: uid}); !member {
		if !s.validGroupInvite(r.Context(), id, strings.TrimSpace(in.Invite)) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "this group needs an invite link to join"})
			return
		}
		if err := s.queries.AddGroupMember(r.Context(), db.AddGroupMemberParams{GroupID: id, UserID: uid}); err != nil {
			s.internal(w, "join group", err)
			return
		}
		s.analytics.Capture(uid, "group_joined", map[string]any{"group_id": r.PathValue("id"), "via": "invite_link"})
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleAddGroupMember(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	if g.OwnerID != uid {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner only"})
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
		s.internal(w, "lookup member", err)
		return
	}
	if err := s.queries.AddGroupMember(r.Context(), db.AddGroupMemberParams{GroupID: g.ID, UserID: prof.UserID}); err != nil {
		s.internal(w, "add member", err)
		return
	}
	s.analytics.Capture(uid, "group_member_added", map[string]any{"group_id": uuidStr(g.ID)})
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

// handleSetGroupIcon uploads a picture icon (owner only) - same contract as
// profile avatars: small data URL or https, replaces the emoji when set.
// handleUpdateGroup edits a group's name + description (owner/admins only).
func (s *server) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	isAdmin, _ := s.queries.IsGroupAdmin(r.Context(), db.IsGroupAdminParams{ID: g.ID, UserID: uid})
	if !isAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admins only"})
		return
	}
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	if in.Name == "" || len(in.Name) > 80 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name is required (max 80)"})
		return
	}
	if len(in.Description) > 500 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "description: max 500 characters"})
		return
	}
	updated, err := s.queries.UpdateGroupDetails(r.Context(), db.UpdateGroupDetailsParams{ID: g.ID, Name: in.Name, Description: in.Description})
	if err != nil {
		s.internal(w, "update group", err)
		return
	}
	s.analytics.Capture(uid, "group_edited", map[string]any{"group_id": r.PathValue("id")})
	writeJSON(w, http.StatusOK, updated)
}

func (s *server) handleSetGroupIcon(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	if g.OwnerID != uid {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner only"})
		return
	}
	var in struct {
		IconURL string `json:"icon_url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(in.IconURL) > 300_000 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "image too large (max ~300KB)"})
		return
	}
	// Same policy as event covers: uploads or the Klipy CDN (validGifURL also
	// admits the stub sentinel in test stacks) - never arbitrary remotes.
	if in.IconURL != "" && !safeImageDataURL(in.IconURL) && !validGifURL(in.IconURL) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "icon must be an uploaded image or a Klipy gif"})
		return
	}
	updated, err := s.queries.SetGroupIcon(r.Context(), db.SetGroupIconParams{ID: g.ID, IconUrl: in.IconURL})
	if err != nil {
		s.internal(w, "set group icon", err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleSetGroupMemberRole grants/revokes admin (owner or admins; the owner's
// implicit admin can't be touched). Admins manage members and are the only
// ones who can create the group's events.
func (s *server) handleSetGroupMemberRole(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	isAdmin, _ := s.queries.IsGroupAdmin(r.Context(), db.IsGroupAdminParams{ID: g.ID, UserID: uid})
	if !isAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admins only"})
		return
	}
	target := r.PathValue("userId")
	if target == g.OwnerID {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "the owner is always an admin"})
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if !oneOf(in.Role, "member", "admin") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "role must be member or admin"})
		return
	}
	if err := s.queries.SetGroupMemberRole(r.Context(), db.SetGroupMemberRoleParams{GroupID: g.ID, UserID: target, Role: in.Role}); err != nil {
		s.internal(w, "set member role", err)
		return
	}
	s.analytics.Capture(uid, "group_role_set", map[string]any{"group_id": r.PathValue("id"), "role": in.Role})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleRemoveGroupMember(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	g, ok := s.loadGroupForMember(w, r)
	if !ok {
		return
	}
	target := r.PathValue("userId")
	// Owner/admins remove anyone (except the owner); a member removes themselves (leave).
	isAdmin, _ := s.queries.IsGroupAdmin(r.Context(), db.IsGroupAdminParams{ID: g.ID, UserID: uid})
	if !isAdmin && target != uid {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admins only"})
		return
	}
	if target == g.OwnerID && uid != g.OwnerID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "the owner can't be removed"})
		return
	}
	if err := s.queries.RemoveGroupMember(r.Context(), db.RemoveGroupMemberParams{GroupID: g.ID, UserID: target}); err != nil {
		s.internal(w, "remove member", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
