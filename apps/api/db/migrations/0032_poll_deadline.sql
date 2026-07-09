-- +goose Up
-- Poll velocity: an optional close date on polls plus once-only email markers
-- (poll-ready to the host, last-chance to invited non-voters, quorum notice).
ALTER TABLE events ADD COLUMN poll_deadline timestamptz;
ALTER TABLE events ADD COLUMN poll_ready_sent boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN vote_reminder_sent boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN quorum_sent boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE events DROP COLUMN quorum_sent;
ALTER TABLE events DROP COLUMN vote_reminder_sent;
ALTER TABLE events DROP COLUMN poll_ready_sent;
ALTER TABLE events DROP COLUMN poll_deadline;
