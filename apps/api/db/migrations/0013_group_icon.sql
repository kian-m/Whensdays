-- +goose Up
-- Group icons: either an emoji (validated server-side — no arbitrary text) or
-- an uploaded picture (small data URL, like profile avatars). icon_url wins
-- over emoji when set.
ALTER TABLE groups ADD COLUMN icon_url text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE groups DROP COLUMN icon_url;
