-- +goose Up
-- Optional event end time. starts_at stays the scheduling anchor; ends_at is
-- display + calendar-export precision (ICS DTEND, "7:30–10 PM" in the UI).
ALTER TABLE events ADD COLUMN ends_at timestamptz;

-- +goose Down
ALTER TABLE events DROP COLUMN ends_at;
