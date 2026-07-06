-- +goose Up
-- Event cover art + page theme, both host-edited:
--   photo_url — a square cover: either a client-resized JPEG data URL (same
--               pattern as avatars/group icons) or a Klipy CDN gif URL.
--   theme     — a preset backdrop slug for the event page (validated server-side).
ALTER TABLE events ADD COLUMN photo_url text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN theme     text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE events DROP COLUMN theme;
ALTER TABLE events DROP COLUMN photo_url;
