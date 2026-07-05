-- ========================= event comments =========================

-- name: ListEventComments :many
SELECT c.id, c.event_id, c.user_id, c.body, c.created_at,
       p.display_name, p.avatar_url
FROM event_comments c
LEFT JOIN profiles p ON p.user_id = c.user_id
WHERE c.event_id = $1
ORDER BY c.created_at;

-- name: AddEventComment :one
INSERT INTO event_comments (event_id, user_id, body)
VALUES ($1, $2, $3)
RETURNING id, event_id, user_id, body, created_at;

-- name: GetEventComment :one
SELECT id, event_id, user_id, body, created_at
FROM event_comments
WHERE id = $1;

-- name: DeleteEventComment :exec
DELETE FROM event_comments WHERE id = $1;

-- ========================== event cohosts =========================

-- name: ListCohosts :many
SELECT ch.user_id, ch.created_at, p.display_name, p.handle, p.avatar_url
FROM event_cohosts ch
LEFT JOIN profiles p ON p.user_id = ch.user_id
WHERE ch.event_id = $1
ORDER BY ch.created_at;

-- name: IsCohost :one
SELECT EXISTS (
    SELECT 1 FROM event_cohosts WHERE event_id = $1 AND user_id = $2
);

-- name: AddCohost :exec
INSERT INTO event_cohosts (event_id, user_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: RemoveCohost :exec
DELETE FROM event_cohosts WHERE event_id = $1 AND user_id = $2;
