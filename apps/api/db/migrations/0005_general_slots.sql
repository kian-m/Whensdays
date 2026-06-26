-- +goose Up
-- Move the general poll from independent weekday/daypart picks to per-day cells:
-- one 'slot' row per (weekday, daypart) the guest selects, value "<weekday>:<daypart>"
-- e.g. "6:evening" = Saturday evening. Months stay as their own dimension.
DELETE FROM event_general_votes WHERE dimension IN ('weekday', 'daypart');
ALTER TABLE event_general_votes DROP CONSTRAINT event_general_votes_dimension_check;
ALTER TABLE event_general_votes ADD CONSTRAINT event_general_votes_dimension_check
    CHECK (dimension IN ('month', 'slot'));

-- +goose Down
DELETE FROM event_general_votes WHERE dimension = 'slot';
ALTER TABLE event_general_votes DROP CONSTRAINT event_general_votes_dimension_check;
ALTER TABLE event_general_votes ADD CONSTRAINT event_general_votes_dimension_check
    CHECK (dimension IN ('month', 'weekday', 'daypart'));
