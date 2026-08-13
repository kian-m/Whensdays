-- ================== activity-notification queue ===================

-- name: EnqueueNotification :exec
INSERT INTO notification_queue (recipient_id, event_id, kind, actor_id, actor_name, body)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: DrainDueNotifications :many
-- Atomically claim every item older than the digest window. DELETE..RETURNING
-- hands each row to exactly one caller, so overlapping flushers (Cloud Run can
-- run 2 instances) can't double-send.
DELETE FROM notification_queue
WHERE created_at < now() - make_interval(mins => $1::int)
RETURNING recipient_id, event_id, kind, actor_id, actor_name, body, created_at;
