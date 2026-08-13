-- +goose Up
-- Recurring events: a fixed-time event can repeat (weekly / biweekly / monthly).
-- Occurrences are pre-materialized as ordinary events sharing a series_id
-- (RSVPs and comments are per-occurrence, which is the semantics people expect;
-- no background jobs needed — fits the scale-to-zero architecture).
ALTER TABLE events ADD COLUMN series_id uuid;
ALTER TABLE events ADD COLUMN recurrence text NOT NULL DEFAULT ''
    CHECK (recurrence IN ('', 'weekly', 'biweekly', 'monthly'));
CREATE INDEX events_series_idx ON events (series_id) WHERE series_id IS NOT NULL;

-- +goose Down
DROP INDEX events_series_idx;
ALTER TABLE events DROP COLUMN recurrence;
ALTER TABLE events DROP COLUMN series_id;
