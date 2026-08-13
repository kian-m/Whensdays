-- +goose Up
-- Following (phase 1). Asymmetric: you follow an artist/venue/club and their
-- upcoming events surface for you. This is NOT Groups (symmetric membership -
-- you join, you see members, admins create events); the two coexist. It is also
-- deliberately NOT called "Subscriptions" - that word already means .ics
-- calendar sync in this product (Calendars.tsx "Subscribe"). Don't rename it.
--
-- (a) follows.kind gains 'group' (value = the group's UUID as text). No 'venue'
--     kind: venue bots are ordinary hosts, so kind='host' already covers them.
ALTER TABLE follows DROP CONSTRAINT follows_kind_check;
ALTER TABLE follows ADD CONSTRAINT follows_kind_check
    CHECK (kind IN ('host', 'topic', 'group'));

-- (b) events.listed - "show this to people who follow me / this group".
--     New events opt IN via the column default (the create wizard's checkbox is
--     checked by default).
ALTER TABLE events ADD COLUMN listed boolean NOT NULL DEFAULT true;
-- CRITICAL backfill: every PRE-EXISTING event must stay hidden from followers.
-- Those events were created before anyone could consent to being listed (the
-- wizard defaults to private visibility and never asked), so inheriting the
-- `true` default would retroactively expose them to a follower's feed. Flip
-- every existing row to false; only events created from here on are listed.
UPDATE events SET listed = false;

CREATE INDEX events_listed_idx ON events (starts_at) WHERE listed = true;

-- +goose Down
DROP INDEX events_listed_idx;
ALTER TABLE events DROP COLUMN listed;
DELETE FROM follows WHERE kind = 'group';
ALTER TABLE follows DROP CONSTRAINT follows_kind_check;
ALTER TABLE follows ADD CONSTRAINT follows_kind_check
    CHECK (kind IN ('host', 'topic'));
