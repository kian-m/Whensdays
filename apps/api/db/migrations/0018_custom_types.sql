-- +goose Up
-- User-defined event types: an emoji + short name. The event keeps
-- event_type='other' (questions/colors/intents stay sane); these two fields
-- override the display. Saved per user for reuse as chips in the wizard.
ALTER TABLE events ADD COLUMN custom_emoji text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN custom_label text NOT NULL DEFAULT '';

CREATE TABLE custom_event_types (
    user_id    text NOT NULL,
    label      text NOT NULL,
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, label)
);

-- +goose Down
DROP TABLE custom_event_types;
ALTER TABLE events DROP COLUMN custom_label;
ALTER TABLE events DROP COLUMN custom_emoji;
