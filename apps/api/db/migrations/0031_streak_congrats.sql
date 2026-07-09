-- +goose Up
-- One congratulation email per group per streak-month (Pacific "YYYY-MM").
-- The insert is the idempotency gate: first cron tick to claim the row sends.
CREATE TABLE group_streak_congrats (
    group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    month text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, month)
);

-- +goose Down
DROP TABLE group_streak_congrats;
