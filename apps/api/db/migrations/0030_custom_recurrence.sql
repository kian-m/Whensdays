-- +goose Up
-- Irregular series (host-picked dates) use recurrence='custom'; the original
-- check only allowed the fixed patterns, which broke multi-date create AND
-- multi-date finalize with a 23514.
ALTER TABLE events DROP CONSTRAINT events_recurrence_check;
ALTER TABLE events ADD CONSTRAINT events_recurrence_check
    CHECK (recurrence IN ('', 'weekly', 'biweekly', 'monthly', 'custom'));

-- +goose Down
ALTER TABLE events DROP CONSTRAINT events_recurrence_check;
ALTER TABLE events ADD CONSTRAINT events_recurrence_check
    CHECK (recurrence IN ('', 'weekly', 'biweekly', 'monthly'));
