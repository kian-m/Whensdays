-- ====================== host nudge ================================

-- name: GetNudgedAt :one
SELECT nudged_at FROM event_nudges WHERE event_id = $1;

-- name: MarkNudged :exec
INSERT INTO event_nudges (event_id, nudged_at)
VALUES ($1, now())
ON CONFLICT (event_id) DO UPDATE SET nudged_at = now();

-- name: ListInvitedNonResponderContacts :many
-- (user_id, email) for invited people who have NOT RSVP'd at all — the Nudge
-- audience. Requires an email, skips anyone who muted this event's mail.
SELECT i.user_id, p.email
FROM event_invites i
JOIN profiles p ON p.user_id = i.user_id
WHERE i.event_id = $1 AND p.email <> ''
  AND NOT EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = i.event_id AND a.user_id = i.user_id)
  AND NOT EXISTS (SELECT 1 FROM event_mutes m WHERE m.event_id = i.event_id AND m.user_id = i.user_id);
