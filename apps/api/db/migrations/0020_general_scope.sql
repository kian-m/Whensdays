-- +goose Up
-- General-availability polls gain a host-chosen scope that shapes the question
-- attendees answer:
--   'week'    — "when are you free this week?"   → concrete dates × dayparts
--   'month'   — "which days work this month?"    → concrete dates
--   'general' — "when are you usually free?"     → months + weekday × daypart (the original)
-- The answer window is anchored at the event's created_at so every attendee
-- answers about the same dates.
ALTER TABLE events
    ADD COLUMN general_scope text NOT NULL DEFAULT 'general'
    CHECK (general_scope IN ('week', 'month', 'general'));

-- New vote dimensions for the scoped answers:
--   dimension='day'     value='2026-07-18'          (month scope)
--   dimension='dayslot' value='2026-07-18:evening'  (week scope)
ALTER TABLE event_general_votes DROP CONSTRAINT event_general_votes_dimension_check;
ALTER TABLE event_general_votes ADD CONSTRAINT event_general_votes_dimension_check
    CHECK (dimension IN ('month', 'slot', 'day', 'dayslot'));

-- +goose Down
DELETE FROM event_general_votes WHERE dimension IN ('day', 'dayslot');
ALTER TABLE event_general_votes DROP CONSTRAINT event_general_votes_dimension_check;
ALTER TABLE event_general_votes ADD CONSTRAINT event_general_votes_dimension_check
    CHECK (dimension IN ('month', 'slot'));
ALTER TABLE events DROP COLUMN general_scope;
