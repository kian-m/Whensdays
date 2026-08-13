-- performers.sql - V7 of the venue-pages playbook (docs/product/VENUE-PAGES.md):
-- performers on events. Mirrors event_cohosts (comments.sql) - real users added
-- by handle, PK(event_id, user_id) - with one addition: status, because a
-- performer's own consent gates whether the event surfaces to THEIR followers
-- (display on the event page is immediate; feed/digest distribution is not).

-- name: AddPerformer :exec
INSERT INTO event_performers (event_id, user_id, added_by)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: ListPerformers :many
SELECT ep.event_id, ep.user_id, ep.status, ep.added_by, ep.created_at,
       p.display_name, p.handle, p.avatar_url
FROM event_performers ep
LEFT JOIN profiles p ON p.user_id = ep.user_id
WHERE ep.event_id = $1
ORDER BY ep.created_at;

-- name: GetPerformer :one
SELECT event_id, user_id, status, added_by, created_at
FROM event_performers
WHERE event_id = $1 AND user_id = $2;

-- name: ConfirmPerformer :one
-- Atomic once-gate mirroring ClaimEventReminder: a row back means this call
-- flipped pending -> confirmed (the performer's consent - see the migration
-- comment). Idempotent: a second tap on the same email link no-ops (no row).
UPDATE event_performers SET status = 'confirmed'
WHERE event_id = $1 AND user_id = $2 AND status = 'pending'
RETURNING event_id;

-- name: RemovePerformer :exec
DELETE FROM event_performers WHERE event_id = $1 AND user_id = $2;
