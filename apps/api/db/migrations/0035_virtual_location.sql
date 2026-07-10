-- +goose Up
-- Online events: location can be a meeting link (Zoom / Meet / whatever) -
-- location_address then holds the https URL.
ALTER TABLE events DROP CONSTRAINT events_location_mode_check;
ALTER TABLE events ADD CONSTRAINT events_location_mode_check
    CHECK (location_mode IN ('host_place', 'find_venue', 'virtual'));

-- +goose Down
ALTER TABLE events DROP CONSTRAINT events_location_mode_check;
ALTER TABLE events ADD CONSTRAINT events_location_mode_check
    CHECK (location_mode IN ('host_place', 'find_venue'));
