-- +goose Up
-- Profile picture. Stored as a small data URL (resized client-side) or an https
-- URL — no object storage needed for the sandbox. Empty string = no photo.
ALTER TABLE profiles ADD COLUMN avatar_url text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE profiles DROP COLUMN avatar_url;
