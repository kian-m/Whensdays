-- +goose Up

-- Add a third scheduling mode: 'general' — guests pick coarse preferences
-- (ideal month(s), weekday(s), and part(s) of day) instead of voting on specific
-- candidate times. The host reads the aggregate and finalizes a concrete time.
ALTER TABLE events DROP CONSTRAINT events_scheduling_mode_check;
ALTER TABLE events ADD CONSTRAINT events_scheduling_mode_check
    CHECK (scheduling_mode IN ('fixed', 'poll', 'general'));

-- A guest's general-availability picks. One row per selected value across three
-- dimensions; a guest's set is replaced on each save (clear + insert).
--   dimension='month'   value='2026-08'      (YYYY-MM)
--   dimension='weekday' value='6'            (0=Sunday … 6=Saturday)
--   dimension='daypart' value='evening'      (early_morning|morning|noon|afternoon|evening|night)
CREATE TABLE event_general_votes (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id  uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id   text NOT NULL,
    dimension text NOT NULL CHECK (dimension IN ('month', 'weekday', 'daypart')),
    value     text NOT NULL,
    UNIQUE (event_id, user_id, dimension, value)
);
CREATE INDEX event_general_votes_event_idx ON event_general_votes (event_id);

-- +goose Down
DROP TABLE event_general_votes;
ALTER TABLE events DROP CONSTRAINT events_scheduling_mode_check;
ALTER TABLE events ADD CONSTRAINT events_scheduling_mode_check
    CHECK (scheduling_mode IN ('fixed', 'poll'));
