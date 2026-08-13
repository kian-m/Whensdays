-- +goose Up
-- Anonymous RSVPs: the response still counts (WhosIn totals, capacity, OG
-- "N in"), but the person's identity is hidden from EVERYONE else on the
-- event - guest list shows "Anonymous", facepiles skip them. Server-side
-- masking in handleGetEvent; the flag itself stays visible on your own row.
ALTER TABLE event_attendees ADD COLUMN anonymous boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE event_attendees DROP COLUMN anonymous;
