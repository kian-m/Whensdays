-- +goose Up
-- V7 of the venue-pages playbook (docs/product/VENUE-PAGES.md): performers on
-- events. Follow a person (follows.kind='host', already means "follow this
-- person") and see any event they're confirmed on, regardless of who hosts.
-- No new follow kind - see the doc for why.
--
-- Performers are real users added by handle (like cohosts) - non-user "special
-- guests" stay in the event description as free text, never a row here.
--
-- Consent gates distribution (anti-hijack): a host can claim ANYONE is on their
-- lineup (display on the event page is immediate, the host's own claim), but
-- feed/digest surfacing to the performer's followers requires the performer's
-- own opt-in - otherwise anyone could tag a well-known performer and blast
-- their followers without consent. status starts 'pending' and only the
-- performer (via the emailed Confirm link, or in-app) can flip it to
-- 'confirmed'; they can also remove themselves anytime. added_by records who
-- attached them (a manager - host or cohost) for audit/display.
CREATE TABLE event_performers (
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
    added_by   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

-- Feed/digest surfacing joins confirmed performers against a viewer's host
-- follows (ListFollowedEvents/ListNewFollowedEvents) - index the lookup path.
CREATE INDEX event_performers_confirmed_idx ON event_performers (user_id) WHERE status = 'confirmed';

-- +goose Down
DROP TABLE event_performers;
