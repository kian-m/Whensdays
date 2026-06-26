-- name: ListNotes :many
SELECT id, user_id, body, created_at
FROM notes
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 100;

-- name: CreateNote :one
INSERT INTO notes (user_id, body)
VALUES ($1, $2)
RETURNING id, user_id, body, created_at;
