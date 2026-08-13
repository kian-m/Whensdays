-- +goose Up
-- Third visibility level: 'friends' — the event shows up for the host's
-- accepted friends (in the feed's Friends scope) without being world-public.
ALTER TABLE events DROP CONSTRAINT events_visibility_check;
ALTER TABLE events ADD CONSTRAINT events_visibility_check
    CHECK (visibility IN ('private', 'friends', 'public'));

-- +goose Down
ALTER TABLE events DROP CONSTRAINT events_visibility_check;
ALTER TABLE events ADD CONSTRAINT events_visibility_check
    CHECK (visibility IN ('private', 'public'));
