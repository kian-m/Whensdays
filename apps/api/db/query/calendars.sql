-- ======================== calendar connections ====================

-- name: ListCalendarConnections :many
SELECT id, user_id, provider, account_label, access_token, refresh_token, token_expiry, ical_url, created_at
FROM calendar_connections
WHERE user_id = $1
ORDER BY provider;

-- name: GetCalendarConnection :one
SELECT id, user_id, provider, account_label, access_token, refresh_token, token_expiry, ical_url, created_at
FROM calendar_connections
WHERE user_id = $1 AND provider = $2;

-- name: UpsertCalendarConnection :one
INSERT INTO calendar_connections (user_id, provider, account_label, access_token, refresh_token, token_expiry, ical_url)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, provider) DO UPDATE
    SET account_label = EXCLUDED.account_label,
        access_token  = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_expiry  = EXCLUDED.token_expiry,
        ical_url      = EXCLUDED.ical_url
RETURNING id, user_id, provider, account_label, access_token, refresh_token, token_expiry, ical_url, created_at;

-- name: UpdateCalendarTokens :exec
UPDATE calendar_connections
SET access_token = $3, refresh_token = $4, token_expiry = $5
WHERE user_id = $1 AND provider = $2;

-- name: DeleteCalendarConnection :exec
DELETE FROM calendar_connections
WHERE user_id = $1 AND provider = $2;

-- name: ListUserFeedEvents :many
-- Everything on the personal .ics feed: upcoming scheduled events the user
-- hosts, cohosts, or is going to (deduped), plus yesterday's (calendar apps
-- like a little trailing context).
SELECT DISTINCT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at, e.comments_enabled, e.group_id, e.series_id, e.recurrence, e.reminder_sent, e.visibility, e.topic, e.city, e.custom_emoji, e.custom_label, e.general_scope, e.photo_url, e.theme, e.timezone, e.ends_at, e.poll_deadline, e.poll_ready_sent, e.vote_reminder_sent, e.quorum_sent, e.capacity
FROM events e
LEFT JOIN event_attendees a ON a.event_id = e.id AND a.user_id = $1 AND a.rsvp = 'going'
LEFT JOIN event_cohosts ch ON ch.event_id = e.id AND ch.user_id = $1
WHERE e.status = 'scheduled' AND e.starts_at IS NOT NULL
  AND e.starts_at >= now() - interval '1 day'
  AND (e.host_id = $1 OR a.user_id IS NOT NULL OR ch.user_id IS NOT NULL)
ORDER BY e.starts_at;
