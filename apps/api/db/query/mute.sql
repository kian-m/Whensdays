-- ==================== notification mutes ==========================

-- name: MuteEvent :exec
INSERT INTO event_mutes (event_id, user_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: UnmuteEvent :exec
DELETE FROM event_mutes WHERE event_id = $1 AND user_id = $2;

-- name: IsEventMuted :one
SELECT EXISTS (
    SELECT 1 FROM event_mutes WHERE event_id = $1 AND user_id = $2
) AS muted;

-- name: ListGoingAttendeeContacts :many
-- (user_id, email) for going attendees with an email who have NOT muted this
-- event — the recipients of finalize/reminder/cancel mail. Returning the user_id
-- lets the sender mint a per-recipient one-click unsubscribe token.
SELECT a.user_id, p.email
FROM event_attendees a
JOIN profiles p ON p.user_id = a.user_id
WHERE a.event_id = $1 AND a.rsvp = 'going' AND p.email <> ''
  AND NOT EXISTS (SELECT 1 FROM event_mutes m WHERE m.event_id = a.event_id AND m.user_id = a.user_id);
