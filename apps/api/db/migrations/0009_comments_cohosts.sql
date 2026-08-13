-- +goose Up
-- Event discussion + delegation:
--   comments_enabled — the host can turn the comment thread on/off per event.
--   event_comments   — a flat comment thread on an event.
--   event_cohosts    — users the host delegates to (a cohost can edit the event,
--                      share the invite link, and moderate comments — but cannot
--                      add/remove other cohosts or toggle comments).
ALTER TABLE events ADD COLUMN comments_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE event_comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_comments_event_idx ON event_comments (event_id, created_at);

CREATE TABLE event_cohosts (
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

-- +goose Down
DROP TABLE event_cohosts;
DROP TABLE event_comments;
ALTER TABLE events DROP COLUMN comments_enabled;
