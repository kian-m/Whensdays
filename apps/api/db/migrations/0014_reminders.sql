-- +goose Up
-- 24h-before reminder emails: a scheduler (e.g. Cloud Scheduler) hits the
-- key-gated /api/cron/reminders endpoint; each scheduled event is reminded once.
ALTER TABLE events ADD COLUMN reminder_sent boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE events DROP COLUMN reminder_sent;
