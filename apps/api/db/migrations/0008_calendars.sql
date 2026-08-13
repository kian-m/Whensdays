-- +goose Up
-- Calendar connections: a user can link external calendars to view their own
-- commitments alongside the scheduler (read-only). Two providers:
--   'google'     — OAuth 2.0; access/refresh tokens stored AES-GCM encrypted.
--   'apple_ical' — a published iCloud .ics URL (Apple has no calendar OAuth);
--                  no credentials stored, just the URL.
-- One connection per (user, provider); re-connecting replaces it.
CREATE TABLE calendar_connections (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       text NOT NULL,
    provider      text NOT NULL CHECK (provider IN ('google', 'apple_ical')),
    account_label text NOT NULL DEFAULT '',  -- email / calendar name, for display
    access_token  text NOT NULL DEFAULT '',  -- google only, encrypted at rest
    refresh_token text NOT NULL DEFAULT '',  -- google only, encrypted at rest
    token_expiry  timestamptz,
    ical_url      text NOT NULL DEFAULT '',  -- apple_ical only (https)
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider)
);
CREATE INDEX calendar_connections_user_idx ON calendar_connections (user_id);

-- +goose Down
DROP TABLE calendar_connections;
