-- +goose Up
-- Which events already got their day-after recap email (idempotent cron), same
-- pattern as event_nudges: a side table so the event column lists stay untouched.
CREATE TABLE event_recaps (
    event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    sent_at  timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE event_recaps;
