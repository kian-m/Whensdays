-- +goose Up
-- Recurring groups (the product wedge): a persistent circle of people who plan
-- together — book club, run group, monthly dinner crew. Events can belong to a
-- group; the group page is the retention surface.
CREATE TABLE groups (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   text NOT NULL,
    name       text NOT NULL,
    emoji      text NOT NULL DEFAULT '👥',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX groups_owner_idx ON groups (owner_id);

CREATE TABLE group_members (
    group_id   uuid NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members (user_id);

ALTER TABLE events ADD COLUMN group_id uuid REFERENCES groups (id) ON DELETE SET NULL;
CREATE INDEX events_group_idx ON events (group_id) WHERE group_id IS NOT NULL;

-- +goose Down
ALTER TABLE events DROP COLUMN group_id;
DROP TABLE group_members;
DROP TABLE groups;
