-- +goose Up
-- The host's IANA timezone (e.g. "America/Los_Angeles"), captured from the
-- browser at event creation. starts_at is still stored as a UTC instant
-- (timestamptz); this column is how server-rendered times (email, .ics) are
-- shown in the event's local time instead of UTC. Empty = fall back to the
-- app's home tz (America/Los_Angeles).
ALTER TABLE events ADD COLUMN timezone text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE events DROP COLUMN timezone;
