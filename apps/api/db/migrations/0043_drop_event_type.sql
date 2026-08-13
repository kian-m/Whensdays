-- Event types are gone from the product: creation no longer asks for one and
-- nothing renders it. Keep the column (historical rows carry dinner/drinks/etc.)
-- but drop the CHECK so new events can store '' — a genuine no-type, not 'other'.
-- +goose Up
ALTER TABLE events DROP CONSTRAINT events_event_type_check;
ALTER TABLE events ALTER COLUMN event_type SET DEFAULT '';

-- +goose Down
ALTER TABLE events ALTER COLUMN event_type DROP DEFAULT;
UPDATE events SET event_type = 'other' WHERE event_type NOT IN ('dinner', 'drinks', 'movie', 'camping', 'party', 'trip', 'show', 'practice', 'openmic', 'other');
ALTER TABLE events ADD CONSTRAINT events_event_type_check
    CHECK (event_type IN ('dinner', 'drinks', 'movie', 'camping', 'party', 'trip', 'show', 'practice', 'openmic', 'other'));
