-- ============================ groups ==============================

-- name: CreateGroup :one
INSERT INTO groups (owner_id, name, emoji)
VALUES ($1, $2, $3)
RETURNING id, owner_id, name, emoji, created_at, icon_url;

-- name: GetGroup :one
SELECT id, owner_id, name, emoji, created_at, icon_url
FROM groups
WHERE id = $1;

-- name: ListMyGroups :many
SELECT DISTINCT g.id, g.owner_id, g.name, g.emoji, g.created_at, g.icon_url
FROM groups g
LEFT JOIN group_members m ON m.group_id = g.id
WHERE g.owner_id = $1 OR m.user_id = $1
ORDER BY g.created_at DESC;

-- name: IsGroupMember :one
SELECT EXISTS (
    SELECT 1 FROM groups g
    LEFT JOIN group_members m ON m.group_id = g.id AND m.user_id = $2
    WHERE g.id = $1 AND (g.owner_id = $2 OR m.user_id IS NOT NULL)
);

-- name: ListGroupMembers :many
SELECT m.user_id, m.created_at, p.display_name, p.handle, p.avatar_url
FROM group_members m
LEFT JOIN profiles p ON p.user_id = m.user_id
WHERE m.group_id = $1
ORDER BY m.created_at;

-- name: AddGroupMember :exec
INSERT INTO group_members (group_id, user_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: RemoveGroupMember :exec
DELETE FROM group_members WHERE group_id = $1 AND user_id = $2;

-- name: ListGroupEvents :many
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope
FROM events
WHERE group_id = $1 AND status <> 'cancelled'
ORDER BY created_at DESC;

-- name: ListGoingAttendeeEmails :many
SELECT p.email
FROM event_attendees a
JOIN profiles p ON p.user_id = a.user_id
WHERE a.event_id = $1 AND a.rsvp = 'going' AND p.email <> '';

-- name: SetGroupIcon :one
UPDATE groups SET icon_url = $2
WHERE id = $1
RETURNING id, owner_id, name, emoji, created_at, icon_url;
