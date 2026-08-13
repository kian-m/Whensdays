package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// followdigest.go - V3 of the venue-pages playbook (docs/product/VENUE-PAGES.md):
// the daily "new events from pages you follow" email. V7 extends the same
// email with a third match arm: a confirmed performer on the event that the
// recipient follows (kind='host') - see ListNewFollowedEvents in
// followdigest.sql for the consent-gated (status='confirmed' only) query.
// Rides the existing daily cron (handleCronReminders) - same idempotency
// religion as every other send in this file's neighbors (notifications.go):
// claim BEFORE building anything, so a scheduler retry (or a second Cloud Run
// instance) can never double-send.
//
// Unlike the per-event reminder/recap claims (ClaimEventReminder/ClaimEventRecap,
// one row per event), this is a single GLOBAL claim - ('follow_digest', run_day)
// in cron_run_claims, same pattern as the analytics digest. Paired with the
// query's "created in the last 24h" window that's an at-most-once guarantee, not
// exactly-once: a missed cron run's events simply age out of the window rather
// than showing up doubled on the next run. That is the deliberate house
// tradeoff the playbook calls out - duplicates are worse than a rare miss.

// signFollow/verifyFollow: the unfollow-from-email token. Namespaced "follow|"
// (own envelope, same key as every other guest-signed capability) so a mute or
// rsvp token can't be replayed here and vice versa. No expiry, like mute/rsvp -
// a footer link in an old email must keep working.
func (g guestSigner) signFollow(userID, kind, value string) string {
	return hmacSeal(g.key, "follow|"+userID+"|"+kind+"|"+value)
}

func (g guestSigner) verifyFollow(token string) (userID, kind, value string, ok bool) {
	payload, ok := hmacOpen(g.key, token)
	if !ok {
		return "", "", "", false
	}
	// SplitN(4): value itself is never expected to contain "|" (host ids are
	// Clerk/guest ids, group ids are UUID text), but capping at 4 keeps this
	// robust either way instead of silently truncating a value that did.
	parts := strings.SplitN(string(payload), "|", 4)
	if len(parts) != 4 || parts[0] != "follow" || parts[1] == "" || parts[2] == "" || parts[3] == "" {
		return "", "", "", false
	}
	return parts[1], parts[2], parts[3], true
}

// followUnsubLink builds the one-click "stop following this page" URL for a
// digest row's footer.
func (s *server) followUnsubLink(userID, kind, value string) string {
	if s.appOrigin == "" {
		return ""
	}
	return s.appOrigin + "/api/follows/unsubscribe?token=" + s.guests.signFollow(userID, kind, value)
}

// handleFollowUnsubscribe is the UNauthenticated one-click link from a follow
// digest email - mail clients send no bearer, so identity+scope ride in the
// HMAC token. Renders the same script-free confirmation page pattern as the
// event mute unsubscribe (unsubPage, mute.go). Idempotent: unfollowing an
// already-unfollowed page is a silent no-op, same as RemoveFollow everywhere
// else.
func (s *server) handleFollowUnsubscribe(w http.ResponseWriter, r *http.Request) {
	userID, kind, value, ok := s.guests.verifyFollow(r.URL.Query().Get("token"))
	if !ok {
		s.unsubPage(w, http.StatusForbidden, "This link isn't valid", "The unfollow link is invalid or malformed.", "", "")
		return
	}
	if err := s.queries.RemoveFollow(r.Context(), db.RemoveFollowParams{UserID: userID, Kind: kind, Value: value}); err != nil {
		s.unsubPage(w, http.StatusInternalServerError, "Something went wrong", "Please try again later.", "", "")
		return
	}
	s.analytics.Capture(userID, "unfollowed", map[string]any{"kind": kind, "value": value, "via": "email"})
	s.unsubPage(w, http.StatusOK, "You're unfollowed", "You won't get any more digest emails about this page.", s.appOrigin, "")
}

// groupFollowedEvents buckets rows per recipient, preserving first-seen order
// (mirrors the byUser/order pattern in sendReminders). Pure - unit-tested
// without a DB, same discipline as collapseActivity.
func groupFollowedEvents(rows []db.ListNewFollowedEventsRow) (map[string][]db.ListNewFollowedEventsRow, []string) {
	byUser := map[string][]db.ListNewFollowedEventsRow{}
	var order []string
	for _, r := range rows {
		if byUser[r.RecipientID] == nil {
			order = append(order, r.RecipientID)
		}
		byUser[r.RecipientID] = append(byUser[r.RecipientID], r)
	}
	return byUser, order
}

// followDigestSubject: "New from pages you follow" normally, but a recipient
// with exactly one new event gets the sharper "{Page}: {Title}" instead - the
// generic subject would waste the one useful piece of information a single-item
// email actually has. Pure - unit-tested.
func followDigestSubject(items []db.ListNewFollowedEventsRow) string {
	if len(items) == 1 {
		return items[0].PageName + ": " + items[0].Title
	}
	return "New from pages you follow"
}

// followKindValue resolves which entity a row's follow matched - group beats
// performer beats host (a page follow is the most specific/intentional; a
// performer follow (V7) is more specific than a bare host follow since it
// names WHO on the lineup earned the send). This is what the row's unfollow
// link targets: for a performer match, that's the performer's own id
// (FollowedHostID), NOT the event's host_id - unfollowing must stop hearing
// about the PERFORMER, not silence the venue that happened to host them.
func followKindValue(it db.ListNewFollowedEventsRow) (kind, value string) {
	if it.ViaGroup {
		return "group", uuidStr(it.GroupID)
	}
	if it.ViaPerformer {
		return "host", it.FollowedHostID
	}
	return "host", it.HostID
}

// sendFollowDigest is V3: one email per recipient listing new listed events
// from the pages (hosts/groups) they follow. Returns the recipient count.
func (s *server) sendFollowDigest(ctx context.Context) int {
	if !s.notify.Enabled() {
		return 0
	}
	loc, lerr := time.LoadLocation(defaultTimeZone)
	if lerr != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	// Claim BEFORE building anything - see the file header. A row back means
	// this attempt owns today's send; no row means another instance/retry
	// already ran it.
	runDay := pgtype.Date{Time: now, Valid: true}
	if _, err := s.queries.ClaimCronRun(ctx, db.ClaimCronRunParams{Job: "follow_digest", RunDay: runDay}); err != nil {
		return 0
	}
	rows, err := s.queries.ListNewFollowedEvents(ctx)
	if err != nil || len(rows) == 0 {
		return 0
	}
	byUser, order := groupFollowedEvents(rows)
	sent := 0
	for _, uid := range order {
		items := byUser[uid]
		recipientEmail := items[0].RecipientEmail
		subject := followDigestSubject(items)

		emailItems := make([]emailItem, 0, len(items))
		var unfollow []emailUnfollowLink
		seenUnfollow := map[string]bool{}
		for _, it := range items {
			// Reuse the existing eventWhen/eventCover helpers by wrapping the
			// row's fields in a stub db.Event - same formatting as every other
			// digest, no duplicated date/tz logic.
			stub := db.Event{Timezone: it.Timezone, StartsAt: it.StartsAt, PhotoUrl: it.PhotoUrl}
			kind, value := followKindValue(it)
			key := kind + "|" + value
			if !seenUnfollow[key] {
				seenUnfollow[key] = true
				unfollow = append(unfollow, emailUnfollowLink{
					label: "Following " + it.PageName + " — unfollow",
					url:   s.followUnsubLink(uid, kind, value),
				})
			}
			emailItems = append(emailItems, emailItem{
				title:           it.Title,
				when:            eventWhen(stub),
				page:            it.PageName,
				pageIsPerformer: it.ViaPerformer,
				url:             campaignURL(s.eventURL(it.ID), "follow_digest"),
				muteURL:         s.muteLink(uid, uuidStr(it.ID)),
				cover:           eventCover(stub),
				rsvpGoingURL:    s.rsvpLink(uid, uuidStr(it.ID), "going"),
				rsvpDeclinedURL: s.rsvpLink(uid, uuidStr(it.ID), "declined"),
			})
		}
		body := renderEmail(emailContent{
			preheader:     "New listed events from the pages you follow.",
			heading:       "New from pages you follow",
			items:         emailItems,
			logoURL:       s.logoURL(),
			unfollowLinks: unfollow,
		})
		s.notify.Send([]string{recipientEmail}, subject, body)
		sent++
	}
	return sent
}
