-- +goose Up
-- New preset event types aimed at performers and local-scene organizers
-- (improv, stand-up, sketch, theater, music) — kept deliberately generic:
--   'show'     — any performance you're putting on or attending together
--   'practice' — rehearsal / practice / jam session
--   'openmic'  — open mic / showcase night
ALTER TABLE events DROP CONSTRAINT events_event_type_check;
ALTER TABLE events ADD CONSTRAINT events_event_type_check
    CHECK (event_type IN ('dinner', 'drinks', 'movie', 'camping', 'party', 'trip', 'show', 'practice', 'openmic', 'other'));

-- +goose Down
ALTER TABLE events DROP CONSTRAINT events_event_type_check;
UPDATE events SET event_type = 'other' WHERE event_type IN ('show', 'practice', 'openmic');
ALTER TABLE events ADD CONSTRAINT events_event_type_check
    CHECK (event_type IN ('dinner', 'drinks', 'movie', 'camping', 'party', 'trip', 'other'));
