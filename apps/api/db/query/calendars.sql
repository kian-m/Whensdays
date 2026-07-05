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
