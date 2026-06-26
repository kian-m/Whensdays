-- +goose Up
-- Replace 'trivia' with 'camping' and add 'trip'. Drop the old check first so the
-- data migration is legal, migrate existing rows, then add the new check.
ALTER TABLE events DROP CONSTRAINT events_event_type_check;
UPDATE events SET event_type = 'camping' WHERE event_type = 'trivia';
ALTER TABLE events ADD CONSTRAINT events_event_type_check
    CHECK (event_type IN ('dinner', 'drinks', 'movie', 'camping', 'party', 'trip', 'other'));

-- +goose Down
ALTER TABLE events DROP CONSTRAINT events_event_type_check;
UPDATE events SET event_type = 'trivia' WHERE event_type IN ('camping', 'trip');
ALTER TABLE events ADD CONSTRAINT events_event_type_check
    CHECK (event_type IN ('dinner', 'drinks', 'movie', 'trivia', 'party', 'other'));
