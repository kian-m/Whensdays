-- +goose Up
-- A new general-poll scope: 'dates'. The host hand-picks specific calendar days
-- (traversing forward as far as they like) and a time window; attendees then
-- paint the ACTUAL clock times that work on those days (a When2meet-style grid),
-- instead of the coarse early-morning→night dayparts of the other scopes.
ALTER TABLE events DROP CONSTRAINT events_general_scope_check;
ALTER TABLE events ADD CONSTRAINT events_general_scope_check
    CHECK (general_scope IN ('week', 'month', 'general', 'dates'));

-- The host-chosen days for a 'dates' poll.
CREATE TABLE event_poll_days (
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    day date NOT NULL,
    PRIMARY KEY (event_id, day)
);

-- The time window + slot size for the grid (minutes from midnight, local wall
-- clock). One row per 'dates' poll. slot_min is the granularity (default 30).
CREATE TABLE event_poll_time_grid (
    event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    start_min int NOT NULL,
    end_min int NOT NULL,
    slot_min int NOT NULL DEFAULT 30
);

-- New vote dimension for the time grid:
--   dimension='timeslot' value='2026-07-18:1110'  (18:30 = 1110 min from midnight)
ALTER TABLE event_general_votes DROP CONSTRAINT event_general_votes_dimension_check;
ALTER TABLE event_general_votes ADD CONSTRAINT event_general_votes_dimension_check
    CHECK (dimension IN ('month', 'slot', 'day', 'dayslot', 'timeslot'));

-- +goose Down
DELETE FROM event_general_votes WHERE dimension = 'timeslot';
ALTER TABLE event_general_votes DROP CONSTRAINT event_general_votes_dimension_check;
ALTER TABLE event_general_votes ADD CONSTRAINT event_general_votes_dimension_check
    CHECK (dimension IN ('month', 'slot', 'day', 'dayslot'));
DROP TABLE event_poll_time_grid;
DROP TABLE event_poll_days;
DELETE FROM events WHERE general_scope = 'dates';
ALTER TABLE events DROP CONSTRAINT events_general_scope_check;
ALTER TABLE events ADD CONSTRAINT events_general_scope_check
    CHECK (general_scope IN ('week', 'month', 'general'));
