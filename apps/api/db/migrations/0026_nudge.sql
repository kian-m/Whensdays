-- +goose Up
-- When the host last nudged this event's non-responders (rate limit: once per
-- day per event). A separate one-row-per-event table rather than a column on
-- events so the (large) event column lists stay untouched.
CREATE TABLE event_nudges (
    event_id  uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    nudged_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE event_nudges;
