-- General polls can now be created WITHOUT a scope chosen yet: the wizard was
-- slimmed to two screens, so the host completes "what does this poll ask?"
-- (week/month/general/dates + any day/time window) from the event page after
-- creating. 'unset' is that not-yet-configured state.
-- +goose Up
ALTER TABLE events DROP CONSTRAINT events_general_scope_check;
ALTER TABLE events ADD CONSTRAINT events_general_scope_check
    CHECK (general_scope IN ('week', 'month', 'general', 'dates', 'unset'));

-- +goose Down
UPDATE events SET general_scope = 'general' WHERE general_scope = 'unset';
ALTER TABLE events DROP CONSTRAINT events_general_scope_check;
ALTER TABLE events ADD CONSTRAINT events_general_scope_check
    CHECK (general_scope IN ('week', 'month', 'general', 'dates'));
