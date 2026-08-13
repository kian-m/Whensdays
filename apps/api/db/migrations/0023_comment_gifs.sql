-- +goose Up
-- Comments can carry a GIF (Klipy CDN URL, server-validated). A comment needs
-- a body or a gif — both is fine too.
ALTER TABLE event_comments ADD COLUMN gif_url text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE event_comments DROP COLUMN gif_url;
