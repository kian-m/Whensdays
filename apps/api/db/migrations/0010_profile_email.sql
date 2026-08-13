-- +goose Up
-- Optional email for transactional notifications (invites, reminders, "time
-- locked"). Empty = no emails. Never required; guests never have one.
ALTER TABLE profiles ADD COLUMN email text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE profiles DROP COLUMN email;
