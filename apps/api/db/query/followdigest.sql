-- ==================== follow digest (V3+V7, cron) =========================
-- The daily "new events from pages you follow" email (see docs/product/
-- VENUE-PAGES.md V3, extended by V7 with a performer arm). One row per
-- (recipient, event) match, from up to THREE reasons: a direct host follow, a
-- group/page follow, or (V7) a follow on a CONFIRMED performer attached to the
-- event, regardless of who hosts it. A recipient who matches more than one way
-- (e.g. follows both the group AND a confirmed performer on the same event)
-- would otherwise get duplicate rows - DISTINCT ON collapses that to ONE row,
-- preferring group > performer > host (page_name/via_* flags follow the same
-- priority; "prio" below is that ordering, highest wins).
--
-- Consent gates the performer arm exactly like the feed's (discover.sql):
-- only status='confirmed' rows qualify, never 'pending'.

-- name: ListNewFollowedEvents :many
WITH live AS (
    -- The shared status/time/freshness filters - factored out so each match
    -- arm below only has to state WHY it matched, not re-derive "is this event
    -- even eligible to appear."
    SELECT * FROM events
    WHERE listed = true
      AND status IN ('polling', 'scheduled')
      AND (starts_at IS NULL OR starts_at >= now())
      -- created in the last 24h - the digest's idempotency window. Paired with
      -- the global (job, run_day) claim in cron_run_claims this is at-most-once,
      -- not exactly-once: a missed run's events simply age out rather than
      -- double-appearing later (the documented house tradeoff).
      AND created_at >= now() - interval '24 hours'
),
raw_matches AS (
    -- Arm 1: direct host follow.
    SELECT p.user_id AS recipient_id, p.email AS recipient_email,
           e.id, e.title, e.starts_at, e.timezone, e.photo_url, e.theme,
           e.host_id, e.group_id,
           hp.display_name::text AS page_name,
           false::bool AS via_group, false::bool AS via_performer,
           ''::text AS followed_host_id, 0 AS prio
    FROM follows f
    JOIN profiles p ON p.user_id = f.user_id
    JOIN live e ON f.value = e.host_id
    LEFT JOIN profiles hp ON hp.user_id = e.host_id
    WHERE f.kind = 'host'

    UNION ALL

    -- Arm 2: group/page follow.
    SELECT p.user_id, p.email,
           e.id, e.title, e.starts_at, e.timezone, e.photo_url, e.theme,
           e.host_id, e.group_id,
           g.name::text,
           true, false,
           ''::text, 2
    FROM follows f
    JOIN profiles p ON p.user_id = f.user_id
    JOIN live e ON e.group_id IS NOT NULL AND f.value = e.group_id::text
    JOIN groups g ON g.id = e.group_id
    WHERE f.kind = 'group'

    UNION ALL

    -- Arm 3 (V7): a follow on a CONFIRMED performer attached to the event -
    -- "follow a person, see every event they're on." followed_host_id carries
    -- the PERFORMER's id (not the event's host_id) so the digest's per-page
    -- unfollow link targets the right person.
    SELECT p.user_id, p.email,
           e.id, e.title, e.starts_at, e.timezone, e.photo_url, e.theme,
           e.host_id, e.group_id,
           pp.display_name::text,
           false, true,
           ep.user_id, 1
    FROM follows f
    JOIN profiles p ON p.user_id = f.user_id
    JOIN event_performers ep ON ep.user_id = f.value AND ep.status = 'confirmed'
    JOIN live e ON e.id = ep.event_id
    JOIN profiles pp ON pp.user_id = ep.user_id
    WHERE f.kind = 'host'
),
matches AS (
    SELECT DISTINCT ON (recipient_id, id)
        recipient_id, recipient_email, id, title, starts_at, timezone, photo_url, theme,
        host_id, group_id, COALESCE(page_name, '')::text AS page_name,
        via_group, via_performer, followed_host_id
    FROM raw_matches
    WHERE recipient_email <> ''
      -- Never tell someone about the event they themselves created.
      AND host_id <> recipient_id
      -- Skip events the recipient already RSVP'd to (any answer, not just going).
      AND NOT EXISTS (
          SELECT 1 FROM event_attendees a
          WHERE a.event_id = raw_matches.id AND a.user_id = raw_matches.recipient_id)
    ORDER BY recipient_id, id, prio DESC
)
SELECT recipient_id, recipient_email, id, title, starts_at, timezone, photo_url, theme, host_id, group_id, page_name, via_group, via_performer, followed_host_id
FROM matches
ORDER BY recipient_id, starts_at NULLS LAST, id;
