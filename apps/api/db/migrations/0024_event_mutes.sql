-- +goose Up
-- Per-recipient mute of an event's notification emails. A row means "do not send
-- this user any email about this event". user_id is a text id (Clerk sub or
-- guest_*), matching profiles.user_id / event_attendees.user_id. Hosts are
-- subscribed by default (no row) and can mute to stop the RSVP/comment stream;
-- attendees can mute finalize/reminder. Set from the app or one-click from email.
CREATE TABLE event_mutes (
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

-- +goose Down
DROP TABLE event_mutes;
