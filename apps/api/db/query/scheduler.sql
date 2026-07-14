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
    visibility, topic, city, custom_emoji, custom_label, general_scope, timezone, ends_at, poll_deadline, capacity
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity;

-- name: GetEvent :one
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity
FROM events
WHERE id = $1;

-- name: ListEventsHosting :many
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity
FROM events
WHERE host_id = $1 AND status <> 'cancelled'
ORDER BY created_at DESC;

-- name: ListEventsAttending :many
SELECT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at, e.comments_enabled, e.group_id, e.series_id, e.recurrence, e.reminder_sent, e.visibility, e.topic, e.city, e.custom_emoji, e.custom_label, e.general_scope, e.photo_url, e.theme, e.timezone, e.ends_at, e.poll_deadline, e.poll_ready_sent, e.vote_reminder_sent, e.quorum_sent, e.capacity
FROM events e
JOIN event_attendees a ON a.event_id = e.id
WHERE a.user_id = $1 AND e.host_id <> $1 AND e.status <> 'cancelled' AND e.status <> 'draft'
  AND NOT EXISTS (SELECT 1 FROM event_cohosts ch WHERE ch.event_id = e.id AND ch.user_id = $1)
ORDER BY e.created_at DESC;

-- name: ListEventsCohosting :many
SELECT e.id, e.host_id, e.title, e.event_type, e.description,
       e.location_mode, e.location_address, e.scheduling_mode, e.starts_at, e.status, e.created_at, e.comments_enabled, e.group_id, e.series_id, e.recurrence, e.reminder_sent, e.visibility, e.topic, e.city, e.custom_emoji, e.custom_label, e.general_scope, e.photo_url, e.theme, e.timezone, e.ends_at, e.poll_deadline, e.poll_ready_sent, e.vote_reminder_sent, e.quorum_sent, e.capacity
FROM events e
JOIN event_cohosts ch ON ch.event_id = e.id
WHERE ch.user_id = $1 AND e.status <> 'cancelled'
ORDER BY e.created_at DESC;

-- name: FinalizeEvent :one
UPDATE events
SET starts_at = $2, status = 'scheduled'
WHERE id = $1
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity;

-- name: UpdateEvent :one
-- starts_at + reminder_sent are set by the handler: the time stays editable
-- after finalize, and rescheduling resets reminder_sent so the day-before
-- reminder re-fires for the new date.
UPDATE events
SET title = $2, description = $3, location_mode = $4, location_address = $5,
    visibility = $6, topic = $7, city = $8, photo_url = $9, theme = $10,
    starts_at = $11, reminder_sent = $12, ends_at = $13, poll_deadline = $14, capacity = $15
WHERE id = $1
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity;

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
    SELECT a.event_id, a.user_id, a.anonymous,
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
               ORDER BY a.anonymous ASC,
                        EXISTS (
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
WHERE rn <= 6 AND NOT anonymous;

-- name: CountScheduledEvents :one
-- Landing-page proof counter: every plan that reached a locked-in time.
SELECT count(*) FROM events WHERE status = 'scheduled';

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

-- ==================== time-grid ('dates') polls ===================

-- name: AddPollDay :exec
INSERT INTO event_poll_days (event_id, day)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: ListPollDays :many
SELECT day
FROM event_poll_days
WHERE event_id = $1
ORDER BY day;

-- name: SetPollTimeGrid :exec
INSERT INTO event_poll_time_grid (event_id, start_min, end_min, slot_min)
VALUES ($1, $2, $3, $4)
ON CONFLICT (event_id) DO UPDATE
    SET start_min = EXCLUDED.start_min, end_min = EXCLUDED.end_min, slot_min = EXCLUDED.slot_min;

-- name: GetPollTimeGrid :one
SELECT start_min, end_min, slot_min
FROM event_poll_time_grid
WHERE event_id = $1;

-- ========================= attendees ==============================

-- name: UpsertRsvp :one
-- Returns a row ONLY when the rsvp actually changed (a fresh INSERT, or an
-- UPDATE to a different value). A no-op re-submit of the same rsvp updates
-- nothing and returns no row, so the handler (treating pgx.ErrNoRows as
-- "unchanged") won't re-notify the host. Race-safe: concurrent conflicting
-- upserts serialize on the (event_id,user_id) unique index, so a second
-- identical "going" sees the just-committed row and its WHERE is false.
INSERT INTO event_attendees (event_id, user_id, rsvp, anonymous)
VALUES ($1, $2, $3, $4)
ON CONFLICT (event_id, user_id) DO UPDATE
    SET rsvp = EXCLUDED.rsvp
    WHERE event_attendees.rsvp IS DISTINCT FROM EXCLUDED.rsvp
RETURNING id, event_id, user_id, rsvp, created_at, anonymous;

-- name: SetRsvpAnonymous :exec
-- The anonymity toggle, separate from UpsertRsvp so flipping it never trips
-- the changed-rsvp notify path, and so email-link re-RSVPs (which don't send
-- the flag) leave a stored choice alone.
UPDATE event_attendees SET anonymous = $3 WHERE event_id = $1 AND user_id = $2;

-- name: ListAttendees :many
SELECT a.user_id, a.rsvp, a.anonymous, p.display_name, p.avatar_url, p.handle
FROM event_attendees a
LEFT JOIN profiles p ON p.user_id = a.user_id
WHERE a.event_id = $1
ORDER BY a.created_at;

-- name: GetAttendee :one
SELECT id, event_id, user_id, rsvp, created_at, anonymous
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
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity;

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

-- name: SetSeries :exec
-- Attach an event to a series after the fact (multi-date finalize).
UPDATE events SET series_id = $2, recurrence = $3 WHERE id = $1;

-- name: SetEventHost :exec
-- Hand an event to another host (the UCB sync bot adopts scraped series;
-- the previous host stays on as cohost - see ucbsync.go).
UPDATE events SET host_id = $2 WHERE id = $1;

-- name: RetimeEvent :exec
-- Move a scheduled occurrence (venue time changed upstream): new start,
-- reminder re-armed so the day-before email fires for the new date.
UPDATE events SET starts_at = $2, reminder_sent = false WHERE id = $1;

-- name: CancelEventQuiet :exec
-- Soft-cancel without the email fan-out (sync-driven: a scraped listing
-- vanishing is weaker evidence than a host's explicit cancel).
UPDATE events SET status = 'cancelled' WHERE id = $1;

-- name: SetEventLook :exec
-- Carry cover + theme onto a sync-created sibling occurrence (CreateEvent
-- has no photo/theme params - those normally arrive via the edit PUT).
UPDATE events SET photo_url = $2, theme = $3 WHERE id = $1;

-- name: CopyAttendees :exec
-- Carry everyone (with their RSVP) onto a sibling occurrence.
INSERT INTO event_attendees (event_id, user_id, rsvp)
SELECT $2::uuid, src.user_id, src.rsvp FROM event_attendees src WHERE src.event_id = $1
ON CONFLICT DO NOTHING;

-- name: CopyInvites :exec
INSERT INTO event_invites (event_id, user_id, inviter_id)
SELECT $2::uuid, src.user_id, src.inviter_id FROM event_invites src WHERE src.event_id = $1
ON CONFLICT DO NOTHING;

-- name: ListVoterProfiles :many
-- Names/avatars for everyone who responded to a poll (general votes or
-- specific-time votes) — a pure voter has no attendee row, so the responder
-- dots can't rely on the attendee list alone.
SELECT DISTINCT p.user_id, p.display_name, p.avatar_url
FROM profiles p
WHERE p.user_id IN (
    SELECT gv.user_id FROM event_general_votes gv WHERE gv.event_id = $1::uuid
    UNION
    SELECT tv.user_id FROM event_time_votes tv
    JOIN event_time_options o ON o.id = tv.option_id
    WHERE o.event_id = $1::uuid
);

-- name: CountGoing :one
-- Going-count for one event - rides on the OG unfurl ("4 in so far") so the
-- link preview in a group chat carries live social pressure.
SELECT count(*)::int FROM event_attendees WHERE event_id = $1 AND rsvp = 'going';

-- name: ListPollsPastDeadline :many
-- Polls whose close date passed without the host locking a time - the cron
-- emails the host ONCE with the winning options (poll_ready_sent gate).
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity
FROM events
WHERE status = 'polling' AND poll_deadline IS NOT NULL
  AND poll_deadline < now() AND poll_ready_sent = false;

-- name: ClaimPollReady :one
-- Atomic once-gate (multi-instance + retry safe): a row back means THIS call
-- owns the poll-ready send; no row = already sent, skip.
UPDATE events SET poll_ready_sent = true
WHERE id = $1 AND poll_ready_sent = false
RETURNING id;

-- name: ListPollsNeedingVoteReminder :many
-- Polls closing within the next cron day - invited non-voters get one
-- last-chance email (vote_reminder_sent gate).
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity
FROM events
WHERE status = 'polling' AND poll_deadline IS NOT NULL
  AND poll_deadline > now() AND poll_deadline <= now() + interval '26 hours'
  AND vote_reminder_sent = false;

-- name: ClaimVoteReminder :one
-- Atomic once-gate (multi-instance + retry safe): a row back means THIS call
-- owns the vote-reminder send; no row = already sent, skip.
UPDATE events SET vote_reminder_sent = true
WHERE id = $1 AND vote_reminder_sent = false
RETURNING id;

-- name: ListInvitedNonVoterContacts :many
-- Invitees with an email who haven't voted on this poll (any dimension).
SELECT p.user_id, p.display_name, p.email
FROM event_invites i
JOIN profiles p ON p.user_id = i.user_id
WHERE i.event_id = $1 AND p.email <> ''
  AND p.user_id NOT IN (
    SELECT gv.user_id FROM event_general_votes gv WHERE gv.event_id = $1
    UNION
    SELECT tv.user_id FROM event_time_votes tv
    JOIN event_time_options o ON o.id = tv.option_id WHERE o.event_id = $1
  );

-- name: CountInvitedNonVoters :one
-- Quorum check: 0 = every invited person has voted.
SELECT count(*)::int FROM event_invites i
WHERE i.event_id = $1
  AND i.user_id NOT IN (
    SELECT gv.user_id FROM event_general_votes gv WHERE gv.event_id = $1
    UNION
    SELECT tv.user_id FROM event_time_votes tv
    JOIN event_time_options o ON o.id = tv.option_id WHERE o.event_id = $1
  );

-- name: CountEventInvites :one
SELECT count(*)::int FROM event_invites WHERE event_id = $1;

-- name: ClaimQuorumSent :one
-- Atomic once-gate (multi-instance safe): no row back = already claimed.
UPDATE events SET quorum_sent = true
WHERE id = $1 AND quorum_sent = false
RETURNING id;

-- name: ListOptionYesCounts :many
-- Winning options for the poll-ready email, best first.
SELECT o.starts_at, count(v.user_id) FILTER (WHERE v.response = 'yes')::int AS yes
FROM event_time_options o
LEFT JOIN event_time_votes v ON v.option_id = o.id
WHERE o.event_id = $1
GROUP BY o.id, o.starts_at
ORDER BY yes DESC, o.starts_at
LIMIT 3;

-- name: ListGeneralTopCells :many
-- Top-voted general-poll cells for the poll-ready email.
SELECT value, count(*)::int AS votes
FROM event_general_votes
WHERE event_id = $1 AND dimension IN ('dayslot', 'slot', 'day')
GROUP BY value
ORDER BY votes DESC, value
LIMIT 3;


-- name: ListOldestWaitlist :one
-- Next in line when a going spot frees up.
SELECT user_id FROM event_attendees
WHERE event_id = $1 AND rsvp = 'waitlist'
ORDER BY created_at
LIMIT 1;

-- name: PromoteAttendee :exec
UPDATE event_attendees SET rsvp = 'going' WHERE event_id = $1 AND user_id = $2 AND rsvp = 'waitlist';

-- name: UpsertAvailabilityDayFree :exec
-- Poll picks flow back into MAIN availability: a concrete dayslot vote marks
-- that cell free (overwriting a stale busy - the guest just said they can).
INSERT INTO availability_days (user_id, day, daypart, status)
VALUES ($1, $2, $3, 'free')
ON CONFLICT (user_id, day, daypart) DO UPDATE SET status = 'free';

-- name: ListMyRsvps :many
-- The viewer's own rsvp per event - dashboard tiles use it to render
-- Attended vs Passed on past events.
SELECT event_id, rsvp FROM event_attendees WHERE user_id = $1;


-- name: SetEventDraft :one
-- Park / publish an event. Publishing derives the live status: a concrete
-- start time means scheduled, otherwise the poll resumes.
UPDATE events
SET status = CASE WHEN $2::bool THEN 'draft'
                  WHEN starts_at IS NOT NULL THEN 'scheduled'
                  ELSE 'polling' END
WHERE id = $1
RETURNING id, host_id, title, event_type, description,
          location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent, capacity;

-- name: CountRegisteredUsers :one
-- The digest's hero stat: real signups (email on file, not a guest id).
SELECT count(*)::int FROM profiles WHERE email <> '' AND user_id NOT LIKE 'guest#_%' ESCAPE '#';

-- name: CountNewRegisteredBetween :one
SELECT count(*)::int FROM profiles
WHERE email <> '' AND user_id NOT LIKE 'guest#_%' ESCAPE '#'
  AND created_at >= $1 AND created_at < $2;

-- name: TopHostsSince :many
-- Digest leaderboard: who created events in the window and how many people
-- they pulled in (invites sent).
SELECT e.host_id,
       count(*)::int AS events_created,
       coalesce((SELECT count(*) FROM event_invites i WHERE i.inviter_id = e.host_id AND i.created_at >= $1), 0)::int AS invites_sent,
       coalesce(p.display_name, '') AS display_name
FROM events e
LEFT JOIN profiles p ON p.user_id = e.host_id
WHERE e.created_at >= $1
GROUP BY e.host_id, p.display_name
ORDER BY events_created DESC, invites_sent DESC
LIMIT 5;

-- name: DatabaseSizeBytes :one
-- Digest tier-runway: how close the (image-heavy) database is to the plan cap.
SELECT pg_database_size(current_database())::bigint;
