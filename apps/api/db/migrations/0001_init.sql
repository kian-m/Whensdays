-- +goose Up
CREATE TABLE notes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL, -- Clerk user id (sub claim)
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_id_created_at_idx ON notes (user_id, created_at DESC);

-- +goose Down
DROP TABLE notes;
