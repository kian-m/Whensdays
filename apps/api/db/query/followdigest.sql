-- ==================== follow digest (V3, cron) =========================
-- The daily "new events from pages you follow" email (see docs/product/
-- VENUE-PAGES.md V3). One row per (recipient, event) match. A recipient who
-- follows BOTH the host and the group of the same event (two separate follow
-- rows) would otherwise match twice - DISTINCT ON collapses that to ONE row,
-- preferring the group match since a page follow is the more specific
-- attribution (page_name reads "via {group}" instead of the host's name).

-- name: ListNewFollowedEvents :many
WITH matches AS (
    SELECT DISTINCT ON (p.user_id, e.id)
        p.user_id AS recipient_id,
        p.email AS recipient_email,
        e.id, e.title, e.starts_at, e.timezone, e.photo_url, e.theme,
        e.host_id, e.group_id,
        COALESCE(g.name, hp.display_name, '')::text AS page_name,
        (f.kind = 'group')::bool AS via_group
    FROM follows f
    JOIN profiles p ON p.user_id = f.user_id
    JOIN events e ON
        (f.kind = 'host' AND f.value = e.host_id)
        OR (f.kind = 'group' AND e.group_id IS NOT NULL AND f.value = e.group_id::text)
    LEFT JOIN groups g ON g.id = e.group_id
    LEFT JOIN profiles hp ON hp.user_id = e.host_id
    WHERE e.listed = true
      AND e.status IN ('polling', 'scheduled')
      AND (e.starts_at IS NULL OR e.starts_at >= now())
      -- created in the last 24h - the digest's idempotency window. Paired with
      -- the global (job, run_day) claim in cron_run_claims this is at-most-once,
      -- not exactly-once: a missed run's events simply age out rather than
      -- double-appearing later (the documented house tradeoff).
      AND e.created_at >= now() - interval '24 hours'
      AND p.email <> ''
      -- Never tell someone about the event they themselves created.
      AND e.host_id <> p.user_id
      -- Skip events the recipient already RSVP'd to (any answer, not just going).
      AND NOT EXISTS (
          SELECT 1 FROM event_attendees a
          WHERE a.event_id = e.id AND a.user_id = p.user_id)
    ORDER BY p.user_id, e.id, (f.kind = 'group') DESC
)
SELECT recipient_id, recipient_email, id, title, starts_at, timezone, photo_url, theme, host_id, group_id, page_name, via_group
FROM matches
ORDER BY recipient_id, starts_at NULLS LAST, id;
