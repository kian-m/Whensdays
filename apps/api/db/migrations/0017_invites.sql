-- +goose Up
-- Direct invites: anyone on an event can invite THEIR friends to it. The
-- invitee sees the event on their dashboard + a red badge until first viewed.
CREATE TABLE event_invites (
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    inviter_id text NOT NULL,
    seen       boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_invites_unseen_idx ON event_invites (user_id) WHERE NOT seen;

-- +goose Down
DROP TABLE event_invites;
