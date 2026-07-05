-- ====================== custom event types ========================

-- name: UpsertCustomType :exec
INSERT INTO custom_event_types (user_id, label, emoji)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, label) DO UPDATE SET emoji = EXCLUDED.emoji;

-- name: ListCustomTypes :many
SELECT label, emoji FROM custom_event_types
WHERE user_id = $1
ORDER BY created_at;
