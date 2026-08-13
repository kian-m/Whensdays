-- +goose Up
-- Group roles: admins (granted by the owner or other admins) manage members
-- and are the only ones - besides the owner - who can create group events.
ALTER TABLE group_members ADD COLUMN role text NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'admin'));

-- +goose Down
ALTER TABLE group_members DROP COLUMN role;
