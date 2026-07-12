package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

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

func (s *server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		Name  string `json:"name"`
		Emoji string `json:"emoji"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 80 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name is required (max 80)"})
		return
	}
	if in.Emoji == "" {
		in.Emoji = "👥"
	} else if !validEmoji(in.Emoji) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "icon must be an emoji"})
		return
	}
	g, err := s.queries.CreateGroup(r.Context(), db.CreateGroupParams{OwnerID: uid, Name: in.Name, Emoji: in.Emoji})
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
	members, err := s.queries.ListGroupMembers(r.Context(), g.ID)
	if err != nil {
		s.internal(w, "list group members", err)
		return
	}
	events, err := s.queries.ListGroupEvents(r.Context(), g.ID)
	if err != nil {
		s.internal(w, "list group events", err)
		return
	}
	isAdmin, _ := s.queries.IsGroupAdmin(r.Context(), db.IsGroupAdminParams{ID: g.ID, UserID: uid})
	writeJSON(w, http.StatusOK, map[string]any{
		"group": g, "members": members, "events": events,
		"is_owner": g.OwnerID == uid, "is_admin": isAdmin,
	})
}

// handleGroupPreview - NOT member-gated: the group link is the invite
// capability (same model as events), so anyone holding it sees what they'd
// be joining. Read-only, minimal fields.
func (s *server) handleGroupPreview(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
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
		s.internal(w, "group preview", err)
		return
	}
	count, _ := s.queries.CountGroupMembers(r.Context(), id)
	member, _ := s.queries.IsGroupMember(r.Context(), db.IsGroupMemberParams{ID: id, UserID: uid})
	writeJSON(w, http.StatusOK, map[string]any{
		"id": g.ID, "name": g.Name, "emoji": g.Emoji, "icon_url": g.IconUrl,
		"member_count": count, "is_member": member,
	})
}

// handleJoinGroup lets ANYONE holding the group link join - including guests
// (they're real low-privilege users). Membership then unlocks the group page
// and its events, exactly like an event invite link unlocks the event.
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
	if err := s.queries.AddGroupMember(r.Context(), db.AddGroupMemberParams{GroupID: id, UserID: uid}); err != nil {
		s.internal(w, "join group", err)
		return
	}
	s.analytics.Capture(uid, "group_joined", map[string]any{"group_id": r.PathValue("id"), "via": "link"})
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
