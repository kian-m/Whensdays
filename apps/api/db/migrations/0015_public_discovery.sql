-- +goose Up
-- Phase 2, public discovery: events can be public (browsable by anyone, by
-- topic or city) and users can follow hosts or topics to build a feed. Online
-- communities can broadcast streams/shows/meetups; every public page is a
-- zero-cost acquisition surface.
ALTER TABLE events ADD COLUMN visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public'));
ALTER TABLE events ADD COLUMN topic text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN city text NOT NULL DEFAULT '';
CREATE INDEX events_public_idx ON events (starts_at) WHERE visibility = 'public';

CREATE TABLE follows (
    user_id    text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('host', 'topic')),
    value      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, value)
);

-- +goose Down
DROP TABLE follows;
DROP INDEX events_public_idx;
ALTER TABLE events DROP COLUMN city;
ALTER TABLE events DROP COLUMN topic;
ALTER TABLE events DROP COLUMN visibility;
