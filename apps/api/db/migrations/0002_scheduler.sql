-- +goose Up

-- Minimal user profile. Identity is the Clerk sub (user_id); handle is the
-- public key friends use to find each other.
CREATE TABLE profiles (
    user_id      text PRIMARY KEY,
    display_name text NOT NULL,
    handle       text NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- General weekly availability: a sparse grid of (weekday, part_of_day) cells the
-- user is generally free. PUT replaces the whole set for a user.
CREATE TABLE availability_slots (
    user_id     text NOT NULL,
    weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
    part_of_day text NOT NULL CHECK (part_of_day IN ('morning', 'afternoon', 'evening')),
    PRIMARY KEY (user_id, weekday, part_of_day)
);

-- Friend graph. A request from requester -> addressee; availability is visible
-- only once status = 'accepted'.
CREATE TABLE friendships (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id text NOT NULL,
    addressee_id text NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (requester_id <> addressee_id),
    UNIQUE (requester_id, addressee_id)
);
CREATE INDEX friendships_addressee_idx ON friendships (addressee_id, status);

-- Events: any get-together. Location is either the host's place (+ address) or a
-- "help me find a venue" placeholder. Time is either fixed up front or decided by
-- an availability poll (event_time_options + event_time_votes).
CREATE TABLE events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id          text NOT NULL,
    title            text NOT NULL,
    event_type       text NOT NULL CHECK (event_type IN ('dinner', 'drinks', 'movie', 'trivia', 'party', 'other')),
    description      text NOT NULL DEFAULT '',
    location_mode    text NOT NULL CHECK (location_mode IN ('host_place', 'find_venue')),
    location_address text NOT NULL DEFAULT '',
    scheduling_mode  text NOT NULL CHECK (scheduling_mode IN ('fixed', 'poll')),
    starts_at        timestamptz,
    status           text NOT NULL DEFAULT 'polling' CHECK (status IN ('polling', 'scheduled', 'cancelled')),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_host_idx ON events (host_id, created_at DESC);

-- Host-proposed candidate times for a poll-mode event.
CREATE TABLE event_time_options (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id  uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL
);
CREATE INDEX event_time_options_event_idx ON event_time_options (event_id, starts_at);

-- A guest's availability on a single candidate time.
CREATE TABLE event_time_votes (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    option_id uuid NOT NULL REFERENCES event_time_options (id) ON DELETE CASCADE,
    user_id   text NOT NULL,
    response  text NOT NULL CHECK (response IN ('yes', 'no', 'maybe')),
    UNIQUE (option_id, user_id)
);

-- RSVP / attendance. A 'going' rsvp on a scheduled event is a concrete
-- commitment that surfaces in the user's (and friends') availability.
CREATE TABLE event_attendees (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    rsvp       text NOT NULL CHECK (rsvp IN ('going', 'maybe', 'declined')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, user_id)
);
CREATE INDEX event_attendees_user_idx ON event_attendees (user_id);

-- Airtable-style preference answers. Question definitions live in the web app
-- (keyed by event_type); the API stores opaque key/value pairs per guest.
CREATE TABLE event_preference_answers (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id      text NOT NULL,
    question_key text NOT NULL,
    answer       text NOT NULL,
    UNIQUE (event_id, user_id, question_key)
);

-- +goose Down
DROP TABLE event_preference_answers;
DROP TABLE event_attendees;
DROP TABLE event_time_votes;
DROP TABLE event_time_options;
DROP TABLE events;
DROP TABLE friendships;
DROP TABLE availability_slots;
DROP TABLE profiles;
