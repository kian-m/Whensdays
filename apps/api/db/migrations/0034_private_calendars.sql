-- +goose Up
-- Private calendar integrations:
--   'apple_caldav' — iCloud CalDAV with an app-specific password (encrypted at
--                    rest in access_token; Apple has no calendar OAuth).
--   'outlook'      — Microsoft Graph OAuth (Calendars.Read), token columns
--                    reused from the Google flow.
ALTER TABLE calendar_connections DROP CONSTRAINT calendar_connections_provider_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_provider_check
    CHECK (provider IN ('google', 'apple_ical', 'apple_caldav', 'outlook'));

-- +goose Down
ALTER TABLE calendar_connections DROP CONSTRAINT calendar_connections_provider_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_provider_check
    CHECK (provider IN ('google', 'apple_ical'));
