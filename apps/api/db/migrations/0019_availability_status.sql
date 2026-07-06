-- +goose Up
-- Availability becomes tri-state. Previously a row's mere presence meant "free"
-- and absence was ambiguous (busy vs. simply not-set). Now each row carries an
-- explicit status: 'free' (green) or 'busy' (red). An absent (day, daypart) is
-- "unselected" — neither free nor busy. Existing rows were all free, so the
-- default backfills them correctly.
ALTER TABLE availability_days
    ADD COLUMN status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'busy'));
ALTER TABLE availability_slots
    ADD COLUMN status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'busy'));

-- +goose Down
ALTER TABLE availability_days DROP COLUMN status;
ALTER TABLE availability_slots DROP COLUMN status;
