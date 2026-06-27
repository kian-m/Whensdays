-- ============================ profiles ============================

-- name: GetProfile :one
SELECT user_id, display_name, handle, avatar_url, created_at
FROM profiles
WHERE user_id = $1;

-- name: GetProfileByHandle :one
SELECT user_id, display_name, handle, avatar_url, created_at
FROM profiles
WHERE handle = $1;

-- name: UpsertProfile :one
INSERT INTO profiles (user_id, display_name, handle)
VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        handle       = EXCLUDED.handle
RETURNING user_id, display_name, handle, avatar_url, created_at;

-- name: SetAvatar :one
UPDATE profiles SET avatar_url = $2
WHERE user_id = $1
RETURNING user_id, display_name, handle, avatar_url, created_at;

-- ======================== availability ============================

-- name: ListAvailability :many
SELECT user_id, weekday, part_of_day
FROM availability_slots
WHERE user_id = $1
ORDER BY weekday, part_of_day;

-- name: ClearAvailability :exec
DELETE FROM availability_slots
WHERE user_id = $1;

-- name: AddAvailabilitySlot :exec
INSERT INTO availability_slots (user_id, weekday, part_of_day)
VALUES ($1, $2, $3)
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
    location_mode, location_address, scheduling_mode, starts_at, status
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at;

-- name: GetEvent :one
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at
FROM events
WHERE id = $1;

-- name: ListEventsHosting :many
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at
FROM events
WHERE host_id = $1 AND status <> 'cancelled'
ORDER BY created_at DESC;

-- name: ListEventsAttending :many
SELECT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at
FROM events e
JOIN event_attendees a ON a.event_id = e.id
WHERE a.user_id = $1 AND e.host_id <> $1 AND e.status <> 'cancelled'
ORDER BY e.created_at DESC;

-- name: FinalizeEvent :one
UPDATE events
SET starts_at = $3, status = 'scheduled'
WHERE id = $1 AND host_id = $2
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at;

-- name: ListUpcomingCommitments :many
SELECT e.id, e.title, e.starts_at
FROM events e
JOIN event_attendees a ON a.event_id = e.id
WHERE a.user_id = $1 AND a.rsvp = 'going'
  AND e.status = 'scheduled' AND e.starts_at >= now()
ORDER BY e.starts_at;

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
INSERT INTO event_attendees (event_id, user_id, rsvp)
VALUES ($1, $2, $3)
ON CONFLICT (event_id, user_id) DO UPDATE
    SET rsvp = EXCLUDED.rsvp
RETURNING id, event_id, user_id, rsvp, created_at;

-- name: ListAttendees :many
SELECT a.user_id, a.rsvp, p.display_name, p.avatar_url
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
