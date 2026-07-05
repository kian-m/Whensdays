-- ========================= event invites ==========================

-- name: AddEventInvite :exec
INSERT INTO event_invites (event_id, user_id, inviter_id)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: ListEventInvites :many
SELECT i.user_id, i.inviter_id, p.display_name
FROM event_invites i
LEFT JOIN profiles p ON p.user_id = i.user_id
WHERE i.event_id = $1
ORDER BY i.created_at;

-- name: CountUnseenInvites :one
SELECT count(*)::int FROM event_invites WHERE user_id = $1 AND NOT seen;

-- name: MarkInvitesSeen :exec
UPDATE event_invites SET seen = true WHERE user_id = $1 AND NOT seen;

-- name: CountPendingIncoming :one
SELECT count(*)::int FROM friendships WHERE addressee_id = $1 AND status = 'pending';

-- name: ListEventsInvited :many
SELECT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at, e.comments_enabled, e.group_id, e.series_id, e.recurrence, e.reminder_sent, e.visibility, e.topic, e.city, e.custom_emoji, e.custom_label
FROM events e
JOIN event_invites i ON i.event_id = e.id
WHERE i.user_id = $1 AND e.status <> 'cancelled' AND e.host_id <> $1
  AND NOT EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = $1)
  AND NOT EXISTS (SELECT 1 FROM event_cohosts ch WHERE ch.event_id = e.id AND ch.user_id = $1)
ORDER BY e.created_at DESC;
