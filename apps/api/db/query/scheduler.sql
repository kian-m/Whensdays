-- ============================ profiles ============================

-- name: GetProfile :one
SELECT user_id, display_name, handle, avatar_url, created_at, email
FROM profiles
WHERE user_id = $1;

-- name: GetProfileByHandle :one
SELECT user_id, display_name, handle, avatar_url, created_at, email
FROM profiles
WHERE handle = $1;

-- name: UpsertProfile :one
-- Name + handle only. Email is owned by the auth provider (Clerk) and synced
-- separately via SetProfileEmail, so a profile edit never clobbers it.
INSERT INTO profiles (user_id, display_name, handle)
VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        handle       = EXCLUDED.handle
RETURNING user_id, display_name, handle, avatar_url, created_at, email;

-- name: SetProfileEmail :one
UPDATE profiles SET email = $2 WHERE user_id = $1
RETURNING user_id, display_name, handle, avatar_url, created_at, email;

-- name: SetAvatar :one
UPDATE profiles SET avatar_url = $2
WHERE user_id = $1
RETURNING user_id, display_name, handle, avatar_url, created_at, email;

-- ======================== availability ============================

-- name: ListAvailability :many
SELECT user_id, weekday, part_of_day, status
FROM availability_slots
WHERE user_id = $1
ORDER BY weekday, part_of_day;

-- name: ClearAvailability :exec
DELETE FROM availability_slots
WHERE user_id = $1;

-- name: AddAvailabilitySlot :exec
INSERT INTO availability_slots (user_id, weekday, part_of_day, status)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- ===================== date-based availability ====================

-- name: ListAvailabilityDays :many
-- The `- 1 day` tolerance keeps "today" from being pruned when the server (UTC)
-- is a calendar day ahead of the client's local date — otherwise an evening save
-- in a western-hemisphere timezone loses its top (today) row on reload. One extra
-- past day is harmless: the client's grid starts at its own local today and never
-- renders it.
SELECT day, daypart, status
FROM availability_days
WHERE user_id = $1 AND day >= CURRENT_DATE - INTERVAL '1 day'
ORDER BY day, daypart;

-- name: ClearAvailabilityDays :exec
DELETE FROM availability_days
WHERE user_id = $1;

-- name: AddAvailabilityDay :exec
INSERT INTO availability_days (user_id, day, daypart, status)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- ========================= friendships ============================

-- name: CreateFriendRequest :one
INSERT INTO friendships (requester_id, addressee_id)
VALUES ($1, $2)
ON CONFLICT (requester_id, addressee_id) DO NOTHING
RETURNING id, requester_id, addressee_id, status, created_at;

-- name: AcceptFriendRequest :one
UPDATE friendships
SET status = 'accepted'
WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
RETURNING id, requester_id, addressee_id, status, created_at;

-- name: ListFriends :many
SELECT
    f.id,
    (CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END)::text AS friend_id,
    p.display_name,
    p.handle,
    p.avatar_url
FROM friendships f
JOIN profiles p
    ON p.user_id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
WHERE f.status = 'accepted'
  AND (f.requester_id = $1 OR f.addressee_id = $1)
ORDER BY p.display_name;

-- name: ListIncomingRequests :many
SELECT f.id, f.requester_id, p.display_name, p.handle
FROM friendships f
JOIN profiles p ON p.user_id = f.requester_id
WHERE f.addressee_id = $1 AND f.status = 'pending'
ORDER BY f.created_at DESC;

-- name: ListOutgoingRequests :many
SELECT f.id, f.addressee_id, p.display_name, p.handle
FROM friendships f
JOIN profiles p ON p.user_id = f.addressee_id
WHERE f.requester_id = $1 AND f.status = 'pending'
ORDER BY f.created_at DESC;

-- name: AreFriends :one
SELECT EXISTS (
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND ((requester_id = $1 AND addressee_id = $2)
        OR (requester_id = $2 AND addressee_id = $1))
) AS are_friends;

-- =========================== events ===============================

-- name: CreateEvent :one
INSERT INTO events (
    host_id, title, event_type, description,
    location_mode, location_address, scheduling_mode, starts_at, status, group_id, series_id, recurrence,
    visibility, topic, city, custom_emoji, custom_label, general_scope, timezone
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone;

-- name: GetEvent :one
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone
FROM events
WHERE id = $1;

-- name: ListEventsHosting :many
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone
FROM events
WHERE host_id = $1 AND status <> 'cancelled'
ORDER BY created_at DESC;

-- name: ListEventsAttending :many
SELECT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at, e.comments_enabled, e.group_id, e.series_id, e.recurrence, e.reminder_sent, e.visibility, e.topic, e.city, e.custom_emoji, e.custom_label, e.general_scope, e.photo_url, e.theme, e.timezone
FROM events e
JOIN event_attendees a ON a.event_id = e.id
WHERE a.user_id = $1 AND e.host_id <> $1 AND e.status <> 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM event_cohosts ch WHERE ch.event_id = e.id AND ch.user_id = $1)
ORDER BY e.created_at DESC;

-- name: ListEventsCohosting :many
SELECT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at, e.comments_enabled, e.group_id, e.series_id, e.recurrence, e.reminder_sent, e.visibility, e.topic, e.city, e.custom_emoji, e.custom_label, e.general_scope, e.photo_url, e.theme, e.timezone
FROM events e
JOIN event_cohosts ch ON ch.event_id = e.id
WHERE ch.user_id = $1 AND e.status <> 'cancelled'
ORDER BY e.created_at DESC;

-- name: FinalizeEvent :one
UPDATE events
SET starts_at = $2, status = 'scheduled'
WHERE id = $1
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone;

-- name: UpdateEvent :one
-- starts_at + reminder_sent are set by the handler: the time stays editable
-- after finalize, and rescheduling resets reminder_sent so the day-before
-- reminder re-fires for the new date.
UPDATE events
SET title = $2, description = $3, location_mode = $4, location_address = $5,
    visibility = $6, topic = $7, city = $8, photo_url = $9, theme = $10,
    starts_at = $11, reminder_sent = $12
WHERE id = $1
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone;

-- name: SetCommentsEnabled :exec
UPDATE events SET comments_enabled = $2 WHERE id = $1;

-- name: ListUpcomingCommitments :many
SELECT e.id, e.title, e.starts_at
FROM events e
JOIN event_attendees a ON a.event_id = e.id
WHERE a.user_id = $1 AND a.rsvp = 'going'
  AND e.status = 'scheduled' AND e.starts_at >= now()
ORDER BY e.starts_at;

-- name: ListGoingFaces :many
-- Avatar-stack preview for event tiles: up to 6 'going' attendees per event,
-- prioritized for the viewer — friends first, then people with a photo, then
-- initials-only — plus the total going count for the "+N more" tail.
SELECT event_id, user_id, display_name, avatar_url, is_friend, going_count
FROM (
    SELECT a.event_id, a.user_id,
           COALESCE(p.display_name, 'Guest') AS display_name,
           COALESCE(p.avatar_url, '')        AS avatar_url,
           EXISTS (
               SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                 AND ((f.requester_id = $1 AND f.addressee_id = a.user_id)
                   OR (f.requester_id = a.user_id AND f.addressee_id = $1))
           ) AS is_friend,
           count(*) OVER (PARTITION BY a.event_id)::int AS going_count,
           row_number() OVER (
               PARTITION BY a.event_id
               ORDER BY EXISTS (
                            SELECT 1 FROM friendships f WHERE f.status = 'accepted'
                              AND ((f.requester_id = $1 AND f.addressee_id = a.user_id)
                                OR (f.requester_id = a.user_id AND f.addressee_id = $1))
                        ) DESC,
                        (COALESCE(p.avatar_url, '') <> '') DESC,
                        COALESCE(p.display_name, '')
           ) AS rn
    FROM event_attendees a
    LEFT JOIN profiles p ON p.user_id = a.user_id
    WHERE a.rsvp = 'going' AND a.event_id = ANY($2::uuid[])
) x
WHERE rn <= 6;

-- ====================== event time options ========================

-- name: AddTimeOption :one
INSERT INTO event_time_options (event_id, starts_at)
VALUES ($1, $2)
RETURNING id, event_id, starts_at;

-- name: ListTimeOptions :many
SELECT id, event_id, starts_at
FROM event_time_options
WHERE event_id = $1
ORDER BY starts_at;

-- name: UpsertVote :one
INSERT INTO event_time_votes (option_id, user_id, response)
VALUES ($1, $2, $3)
ON CONFLICT (option_id, user_id) DO UPDATE
    SET response = EXCLUDED.response
RETURNING id, option_id, user_id, response;

-- name: ListVotesForEvent :many
SELECT v.id, v.option_id, v.user_id, v.response
FROM event_time_votes v
JOIN event_time_options o ON o.id = v.option_id
WHERE o.event_id = $1;

-- ====================== general poll votes ========================

-- name: ClearGeneralVotes :exec
DELETE FROM event_general_votes
WHERE event_id = $1 AND user_id = $2;

-- name: AddGeneralVote :exec
INSERT INTO event_general_votes (event_id, user_id, dimension, value)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: ListGeneralVotesForEvent :many
SELECT user_id, dimension, value
FROM event_general_votes
WHERE event_id = $1;

-- ========================= attendees ==============================

-- name: UpsertRsvp :one
-- Returns a row ONLY when the rsvp actually changed (a fresh INSERT, or an
-- UPDATE to a different value). A no-op re-submit of the same rsvp updates
-- nothing and returns no row, so the handler (treating pgx.ErrNoRows as
-- "unchanged") won't re-notify the host. Race-safe: concurrent conflicting
-- upserts serialize on the (event_id,user_id) unique index, so a second
-- identical "going" sees the just-committed row and its WHERE is false.
INSERT INTO event_attendees (event_id, user_id, rsvp)
VALUES ($1, $2, $3)
ON CONFLICT (event_id, user_id) DO UPDATE
    SET rsvp = EXCLUDED.rsvp
    WHERE event_attendees.rsvp IS DISTINCT FROM EXCLUDED.rsvp
RETURNING id, event_id, user_id, rsvp, created_at;

-- name: ListAttendees :many
SELECT a.user_id, a.rsvp, p.display_name, p.avatar_url, p.handle
FROM event_attendees a
LEFT JOIN profiles p ON p.user_id = a.user_id
WHERE a.event_id = $1
ORDER BY a.created_at;

-- name: GetAttendee :one
SELECT id, event_id, user_id, rsvp, created_at
FROM event_attendees
WHERE event_id = $1 AND user_id = $2;

-- ===================== preference answers =========================

-- name: UpsertPreferenceAnswer :one
INSERT INTO event_preference_answers (event_id, user_id, question_key, answer)
VALUES ($1, $2, $3, $4)
ON CONFLICT (event_id, user_id, question_key) DO UPDATE
    SET answer = EXCLUDED.answer
RETURNING id, event_id, user_id, question_key, answer;

-- name: ListPreferenceAnswersForEvent :many
SELECT pa.user_id, pa.question_key, pa.answer, p.display_name
FROM event_preference_answers pa
LEFT JOIN profiles p ON p.user_id = pa.user_id
WHERE pa.event_id = $1
ORDER BY pa.user_id, pa.question_key;

-- name: ListSeriesEvents :many
SELECT id, starts_at, status
FROM events
WHERE series_id = $1 AND status <> 'cancelled'
ORDER BY starts_at;

-- name: GetFriendship :one
SELECT id, requester_id, addressee_id, status, created_at
FROM friendships
WHERE id = $1;

-- name: DeleteFriendship :exec
DELETE FROM friendships WHERE id = $1;

-- name: CancelEvent :one
UPDATE events SET status = 'cancelled'
WHERE id = $1
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone;

-- name: CancelSeries :exec
UPDATE events SET status = 'cancelled' WHERE series_id = $1;

-- name: DeleteGroup :exec
DELETE FROM groups WHERE id = $1 AND owner_id = $2;

-- name: ListAttendeeAvailabilityForEvent :many
-- Every attendee's date-based availability — the input for ranking a poll's
-- candidate times against the WHOLE group, not just the viewer.
SELECT ad.user_id, ad.day, ad.daypart, ad.status
FROM availability_days ad
WHERE ad.user_id IN (SELECT user_id FROM event_attendees WHERE event_id = $1);
