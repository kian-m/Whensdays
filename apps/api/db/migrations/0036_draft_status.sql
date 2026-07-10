-- +goose Up
-- Drafts: an event the host parks - content kept, hidden from everyone but
-- managers, inert (no RSVPs/votes/reminders/emails). Publishing restores
-- polling or scheduled (derived from whether a start time exists).
ALTER TABLE events DROP CONSTRAINT events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
    CHECK (status IN ('polling', 'scheduled', 'cancelled', 'draft'));

-- +goose Down
ALTER TABLE events DROP CONSTRAINT events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
    CHECK (status IN ('polling', 'scheduled', 'cancelled'));
