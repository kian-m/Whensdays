-- ==================== reminders (cron) ============================

-- name: ListEventsNeedingReminder :many
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope
FROM events
WHERE status = 'scheduled' AND reminder_sent = false
  AND starts_at > now() AND starts_at <= now() + interval '24 hours';

-- name: MarkEventReminded :exec
UPDATE events SET reminder_sent = true WHERE id = $1;

-- ==================== public discovery ============================

-- name: ListPublicEvents :many
SELECT e.id, e.title, e.event_type, e.starts_at, e.topic, e.city,
       p.display_name AS host_name, p.avatar_url AS host_avatar, e.host_id, e.custom_emoji, e.custom_label,
       (SELECT count(*)::int FROM event_attendees a
          JOIN friendships f ON f.status = 'accepted'
           AND ((f.requester_id = $3::text AND f.addressee_id = a.user_id)
             OR (f.addressee_id = $3::text AND f.requester_id = a.user_id))
        WHERE a.event_id = e.id AND a.rsvp = 'going') AS friends_going,
       COALESCE((SELECT a2.rsvp FROM event_attendees a2 WHERE a2.event_id = e.id AND a2.user_id = $3::text), '')::text AS viewer_rsvp,
       (EXISTS(SELECT 1 FROM friendships f2 WHERE f2.status = 'accepted'
           AND ((f2.requester_id = $3::text AND f2.addressee_id = e.host_id)
             OR (f2.addressee_id = $3::text AND f2.requester_id = e.host_id))))::bool AS from_friend
FROM events e
LEFT JOIN profiles p ON p.user_id = e.host_id
WHERE e.status IN ('polling', 'scheduled')
  AND (e.starts_at IS NULL OR e.starts_at >= now())
  AND (e.visibility = 'public'
    OR ($3::text <> '' AND e.visibility = 'friends' AND EXISTS(
        SELECT 1 FROM friendships ff WHERE ff.status = 'accepted'
          AND ((ff.requester_id = $3 AND ff.addressee_id = e.host_id)
            OR (ff.addressee_id = $3 AND ff.requester_id = e.host_id)))))
  AND ($1::text = '' OR e.topic = $1)
  AND (cardinality($2::text[]) = 0 OR e.city ILIKE ANY($2::text[]))
ORDER BY e.starts_at NULLS LAST
LIMIT 100;

-- name: ListFeedEvents :many
SELECT e.id, e.title, e.event_type, e.starts_at, e.topic, e.city,
       p.display_name AS host_name, p.avatar_url AS host_avatar, e.host_id
FROM events e
LEFT JOIN profiles p ON p.user_id = e.host_id
WHERE e.visibility = 'public' AND e.status = 'scheduled' AND e.starts_at >= now()
  AND (e.host_id IN (SELECT value FROM follows f WHERE f.user_id = $1 AND kind = 'host')
    OR (e.topic <> '' AND e.topic IN (SELECT value FROM follows f WHERE f.user_id = $1 AND kind = 'topic')))
ORDER BY e.starts_at NULLS LAST
LIMIT 100;

-- ========================== follows ===============================

-- name: AddFollow :exec
INSERT INTO follows (user_id, kind, value)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: RemoveFollow :exec
DELETE FROM follows WHERE user_id = $1 AND kind = $2 AND value = $3;

-- name: ListFollows :many
SELECT kind, value FROM follows WHERE user_id = $1 ORDER BY created_at;

-- ==================== feed ranking signals =========================

-- name: ListUserRsvpHistory :many
SELECT e.host_id, e.topic, e.event_type
FROM event_attendees a
JOIN events e ON e.id = a.event_id
WHERE a.user_id = $1 AND a.rsvp IN ('going', 'maybe')
ORDER BY a.created_at DESC
LIMIT 200;

-- name: ListFriendIDs :many
SELECT (CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END)::text AS friend_id
FROM friendships f
WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1);

-- name: CountGoingForPublicUpcoming :many
SELECT a.event_id, count(*)::int AS going
FROM event_attendees a
JOIN events e ON e.id = a.event_id
WHERE e.visibility = 'public' AND e.status = 'scheduled' AND e.starts_at >= now()
  AND a.rsvp = 'going'
GROUP BY a.event_id;

-- name: CountFriendGoingForPublicUpcoming :many
SELECT a.event_id, count(*)::int AS going
FROM event_attendees a
JOIN events e ON e.id = a.event_id
WHERE e.visibility = 'public' AND e.status = 'scheduled' AND e.starts_at >= now()
  AND a.rsvp = 'going' AND a.user_id = ANY($1::text[])
GROUP BY a.event_id;

-- name: ListFriendsEvents :many
SELECT e.id, e.title, e.event_type, e.starts_at, e.topic, e.city,
       p.display_name AS host_name, p.avatar_url AS host_avatar, e.host_id, e.custom_emoji, e.custom_label,
       (SELECT count(*)::int FROM event_attendees a
          JOIN friendships f ON f.status = 'accepted'
           AND ((f.requester_id = $1::text AND f.addressee_id = a.user_id)
             OR (f.addressee_id = $1::text AND f.requester_id = a.user_id))
        WHERE a.event_id = e.id AND a.rsvp = 'going') AS friends_going,
       COALESCE((SELECT a2.rsvp FROM event_attendees a2 WHERE a2.event_id = e.id AND a2.user_id = $1::text), '')::text AS viewer_rsvp,
       (EXISTS(SELECT 1 FROM friendships f2 WHERE f2.status = 'accepted'
           AND ((f2.requester_id = $1::text AND f2.addressee_id = e.host_id)
             OR (f2.addressee_id = $1::text AND f2.requester_id = e.host_id))))::bool AS from_friend
FROM events e
LEFT JOIN profiles p ON p.user_id = e.host_id
WHERE e.status IN ('polling', 'scheduled')
  AND (e.starts_at IS NULL OR e.starts_at >= now())
  AND e.visibility IN ('friends', 'public')
  AND e.host_id IN (
      SELECT (CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END)::text
      FROM friendships f
      WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1))
ORDER BY e.starts_at NULLS LAST
LIMIT 100;

-- name: ListPeopleYouMayKnow :many
-- Suggests people you've co-attended events with, ranked by how meaningful the
-- overlap is: a shared public event is the weakest signal; both being "going"
-- to a friends-only or invite-only (link) event is the strongest. Excludes
-- yourself, guests, and anyone you already have a friendship/request with.
SELECT
    other.user_id AS friend_id,
    p.display_name,
    p.handle,
    p.avatar_url,
    SUM(
        (CASE e.visibility WHEN 'public' THEN 1 WHEN 'friends' THEN 3 ELSE 4 END)
        + (CASE WHEN me.rsvp = 'going' AND other.rsvp = 'going'
                THEN (CASE e.visibility WHEN 'public' THEN 1 WHEN 'friends' THEN 3 ELSE 4 END)
                ELSE 0 END)
    )::int AS score,
    COUNT(DISTINCT e.id)::int AS shared_events
FROM event_attendees me
JOIN event_attendees other ON other.event_id = me.event_id AND other.user_id <> me.user_id
JOIN events e ON e.id = me.event_id
JOIN profiles p ON p.user_id = other.user_id
WHERE me.user_id = $1
  AND me.rsvp IN ('going', 'maybe')
  AND other.rsvp IN ('going', 'maybe')
  AND other.user_id NOT LIKE 'guest_%'
  AND NOT EXISTS (
      SELECT 1 FROM friendships f
      WHERE (f.requester_id = $1 AND f.addressee_id = other.user_id)
         OR (f.addressee_id = $1 AND f.requester_id = other.user_id))
GROUP BY other.user_id, p.display_name, p.handle, p.avatar_url
ORDER BY score DESC, shared_events DESC
LIMIT 12;
