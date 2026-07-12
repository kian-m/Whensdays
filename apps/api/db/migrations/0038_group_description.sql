-- +goose Up
ALTER TABLE groups ADD COLUMN description text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE groups DROP COLUMN description;
