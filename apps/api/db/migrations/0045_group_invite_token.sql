-- +goose Up
-- Two links off one group: the bare /g/{id} page is PUBLIC (view + follow), and
-- joining now requires a signed invite link, /g/{id}?invite=<token>.
--
-- The token is HMAC'd over "group|<group_id>|<version>" with the same server key
-- as every other capability link (guest bearers, mute|, rsvp|, icsfeed|). The
-- version column is what makes per-group revocation possible: "regenerate this
-- group's invite link" bumps THIS row, so only that group's outstanding links
-- die. Signing over the bare key alone would mean the only way to revoke one
-- group's link is rotating GUEST_TOKEN_KEY, which would simultaneously kill
-- every guest session, unsubscribe link, one-tap RSVP link, and .ics feed in
-- the wild.
ALTER TABLE groups ADD COLUMN invite_token_version integer NOT NULL DEFAULT 1;

-- +goose Down
ALTER TABLE groups DROP COLUMN invite_token_version;
