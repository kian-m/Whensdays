-- +goose Up
-- Debounce queue for activity email (comments, RSVPs): rows sit here for a
-- digest window instead of emailing the host per action — someone flip-flopping
-- an RSVP or firing five comments produces ONE email, not five.
CREATE TABLE notification_queue (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id text NOT NULL,
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('comment', 'rsvp')),
    actor_id     text NOT NULL,
    actor_name   text NOT NULL,
    body         text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_queue_created_idx ON notification_queue (created_at);

-- +goose Down
DROP TABLE notification_queue;
