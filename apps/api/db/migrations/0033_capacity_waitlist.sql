-- +goose Up
-- Capacity + waitlist: events can cap 'going' (0 = unlimited). Beyond the cap
-- an RSVP lands on the waitlist; when a spot frees, the oldest waitlisted
-- person is auto-promoted (and emailed).
ALTER TABLE events ADD COLUMN capacity int NOT NULL DEFAULT 0;
ALTER TABLE event_attendees DROP CONSTRAINT event_attendees_rsvp_check;
ALTER TABLE event_attendees ADD CONSTRAINT event_attendees_rsvp_check
    CHECK (rsvp IN ('going', 'maybe', 'declined', 'waitlist'));

-- +goose Down
ALTER TABLE event_attendees DROP CONSTRAINT event_attendees_rsvp_check;
ALTER TABLE event_attendees ADD CONSTRAINT event_attendees_rsvp_check
    CHECK (rsvp IN ('going', 'maybe', 'declined'));
ALTER TABLE events DROP COLUMN capacity;
