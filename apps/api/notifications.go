package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// notifications.go — the transactional-email triggers (growth priority #2).
// Copy + layout live in emails.go; this file decides *who* gets *which* message
// and fills the variables from the event. All best-effort: failures are logged
// by the notify client, never surfaced to the request.

func (s *server) eventURL(id pgtype.UUID) string {
	return s.appOrigin + "/e/" + uuidStr(id)
}

// logoURL is the hosted PNG the web app serves (SVG/transparency renders black in
// many mail clients, so email uses the flattened apple-touch icon).
func (s *server) logoURL() string {
	if s.appOrigin == "" {
		return ""
	}
	return s.appOrigin + "/apple-touch-icon.png"
}

// defaultTimeZone is the fallback for events with no stored tz (created before
// the timezone column, or with an unrecognized name) — the app's home tz.
const defaultTimeZone = "America/Los_Angeles"

// eventLocation resolves the event's IANA timezone (the host's, captured at
// creation), falling back to the app tz then UTC. The tz database is embedded in
// the binary (time/tzdata import in main.go) so this works on the distroless
// image, which ships no OS tzdata.
func eventLocation(ev db.Event) *time.Location {
	if ev.Timezone != "" {
		if loc, err := time.LoadLocation(ev.Timezone); err == nil {
			return loc
		}
	}
	if loc, err := time.LoadLocation(defaultTimeZone); err == nil {
		return loc
	}
	return time.UTC
}

// eventWhen renders the locked time in the event's local timezone (with the tz
// abbreviation), or "" if the event has no time yet.
func eventWhen(ev db.Event) string {
	if !ev.StartsAt.Valid {
		return ""
	}
	return ev.StartsAt.Time.In(eventLocation(ev)).Format("Mon Jan 2 · 3:04 PM MST")
}

// eventMeta builds the When/Where fact rows shown in time-bearing emails.
func eventMeta(ev db.Event) []emailMetaRow {
	var rows []emailMetaRow
	if w := eventWhen(ev); w != "" {
		rows = append(rows, emailMetaRow{"When", w})
	}
	if ev.LocationAddress != "" {
		rows = append(rows, emailMetaRow{"Where", ev.LocationAddress})
	}
	return rows
}

// broadcastToGoing renders `build` once per going, unmuted attendee (so each
// message carries its own one-click links) and sends individually. build
// receives the recipient's user id (for signed per-recipient links) and their
// unsubscribe URL. Returns the recipient count.
func (s *server) broadcastToGoing(ctx context.Context, ev db.Event, subject string, build func(userID, unsub string) emailContent) int {
	if !s.notify.Enabled() {
		return 0
	}
	contacts, err := s.queries.ListGoingAttendeeContacts(ctx, ev.ID)
	if err != nil {
		return 0
	}
	for _, c := range contacts {
		s.notify.Send([]string{c.Email}, subject, renderEmail(build(c.UserID, s.muteLink(c.UserID, uuidStr(ev.ID)))))
	}
	return len(contacts)
}

// notifyFinalized emails every 'going', unmuted attendee once a time is locked in.
func (s *server) notifyFinalized(ctx context.Context, ev db.Event) {
	s.broadcastToGoing(ctx, ev, fmt.Sprintf("It's on — %s is locked in 🎉", ev.Title), func(_, unsub string) emailContent {
		return emailContent{
			preheader: "A time is set — here are the details.",
			heading:   ev.Title + " has a time 🎉",
			lines:     []string{"Good news — the group landed on a time. Add it to your calendar so it actually happens."},
			meta:      eventMeta(ev),
			ctaLabel:  "View the plan →",
			ctaURL:    campaignURL(s.eventURL(ev.ID), "finalized"),
			logoURL:   s.logoURL(),
			unsubURL:  unsub,
		}
	})
}

// notifyReminder emails every 'going', unmuted attendee ~24h out (called by the
// cron). Returns the number of recipients (for the cron's telemetry).
func (s *server) notifyReminder(ctx context.Context, ev db.Event) int {
	return s.broadcastToGoing(ctx, ev, "Tomorrow: "+ev.Title, func(userID, unsub string) emailContent {
		return emailContent{
			preheader: "Happening soon — don't forget.",
			heading:   ev.Title + " is tomorrow",
			lines:     []string{"Just a heads up — this is coming up soon. See you there!"},
			meta:      eventMeta(ev),
			ctaLabel:  "See the details →",
			ctaURL:    campaignURL(s.eventURL(ev.ID), "reminder"),
			moreLabel: "Can't make it anymore?",
			moreURL:   s.rsvpLink(userID, uuidStr(ev.ID), "declined"),
			logoURL:   s.logoURL(),
			unsubURL:  unsub,
		}
	})
}

// notifyInvite emails one invitee with one-tap RSVP buttons. Shared by the
// normal friend-invite flow and the series re-poll (invite_from on create).
func (s *server) notifyInvite(ctx context.Context, ev db.Event, inviterID, inviteeID string) {
	if !s.notify.Enabled() {
		return
	}
	p, err := s.queries.GetProfile(ctx, inviteeID)
	if err != nil || p.Email == "" {
		return
	}
	inviter, err := s.queries.GetProfile(ctx, inviterID)
	if err != nil {
		return
	}
	verb := "invited you. One tap and you're in."
	if ev.Status == "polling" {
		verb = "wants to find the next time that works — cast your vote."
	}
	body := renderEmail(emailContent{
		preheader: inviter.DisplayName + " invited you to " + ev.Title,
		heading:   "You're invited to " + ev.Title,
		lines:     []string{inviter.DisplayName + " " + verb},
		meta:      eventMeta(ev),
		ctaLabel:  "✅ I'm going",
		ctaURL:    s.rsvpLink(inviteeID, uuidStr(ev.ID), "going"),
		cta2Label: "Can't make it",
		cta2URL:   s.rsvpLink(inviteeID, uuidStr(ev.ID), "declined"),
		moreLabel: "See the details first",
		moreURL:   campaignURL(s.eventURL(ev.ID), "invite"),
		logoURL:   s.logoURL(),
		unsubURL:  s.muteLink(inviteeID, uuidStr(ev.ID)),
	})
	s.notify.Send([]string{p.Email}, "You're invited: "+ev.Title, body)
}

// notifyRecap is the day-after email that closes the loop: pull everyone back
// to the thread (the group's memory) and hand the host the next event
// pre-filled. Post-event is where the next event is born.
func (s *server) notifyRecap(ctx context.Context, ev db.Event) int {
	return s.broadcastToGoing(ctx, ev, "How was "+ev.Title+"?", func(_, unsub string) emailContent {
		return emailContent{
			preheader: "Relive it — and plan the next one.",
			heading:   "How was " + ev.Title + "? 📸",
			lines:     []string{"Drop a photo or a highlight in the thread — it's the group's memory now.", "And if it was a good one… same time next month?"},
			ctaLabel:  "Drop a pic 📸",
			ctaURL:    campaignURL(s.eventURL(ev.ID), "recap"),
			cta2Label: "Plan the next one",
			cta2URL:   campaignURL(s.appOrigin+"/new?again="+uuidStr(ev.ID), "recap_next"),
			logoURL:   s.logoURL(),
			unsubURL:  unsub,
		}
	})
}

// notifySeriesEnded nudges the HOST when a series' last scheduled occurrence
// has happened: re-poll the group for the next dates (one tap into a prefilled
// poll that re-invites everyone via invite_from).
func (s *server) notifySeriesEnded(ctx context.Context, ev db.Event) {
	if !s.notify.Enabled() {
		return
	}
	if muted, _ := s.queries.IsEventMuted(ctx, db.IsEventMutedParams{EventID: ev.ID, UserID: ev.HostID}); muted {
		return
	}
	host, err := s.queries.GetProfile(ctx, ev.HostID)
	if err != nil || host.Email == "" {
		return
	}
	body := renderEmail(emailContent{
		preheader: "That was the last one on the calendar.",
		heading:   "Keep " + ev.Title + " going 🔁",
		lines:     []string{"That was the last scheduled date for this series. One tap opens a poll with everyone already invited — find the next times that work."},
		ctaLabel:  "Poll the group for next dates",
		ctaURL:    campaignURL(s.appOrigin+"/new?again="+uuidStr(ev.ID)+"&repoll=1", "repoll"),
		logoURL:   s.logoURL(),
		unsubURL:  s.muteLink(ev.HostID, uuidStr(ev.ID)),
	})
	s.notify.Send([]string{host.Email}, "Plan the next "+ev.Title+"?", body)
}

// notifyNewComment tells the host someone commented (unless the host is the actor).
func (s *server) notifyNewComment(ctx context.Context, ev db.Event, actorID, actorName, text string) {
	s.notifyHostActivity(ctx, ev, actorID, "comment",
		fmt.Sprintf("💬 %s commented on %s", actorName, ev.Title),
		actorName+" commented on "+ev.Title,
		[]string{actorName + " left a comment:"},
		text)
}

// notifyNewRSVP tells the host someone RSVP'd going (unless the host is the actor).
func (s *server) notifyNewRSVP(ctx context.Context, ev db.Event, actorID, actorName string) {
	s.notifyHostActivity(ctx, ev, actorID, "rsvp",
		fmt.Sprintf("✅ %s is going to %s", actorName, ev.Title),
		actorName+" is going to "+ev.Title,
		[]string{actorName + " just RSVP'd — they're going. 🎉"},
		"")
}

// notifyHostActivity is the shared "someone did something on your event" mail.
// Hosts are subscribed to their own events' activity by default; the message is
// skipped when the host themselves is the actor.
func (s *server) notifyHostActivity(ctx context.Context, ev db.Event, actorID, campaign, subject, heading string, lines []string, quote string) {
	if !s.notify.Enabled() || actorID == ev.HostID {
		return
	}
	// Honour a host who muted this event's activity stream.
	if muted, _ := s.queries.IsEventMuted(ctx, db.IsEventMutedParams{EventID: ev.ID, UserID: ev.HostID}); muted {
		return
	}
	host, err := s.queries.GetProfile(ctx, ev.HostID)
	if err != nil || host.Email == "" {
		return
	}
	body := renderEmail(emailContent{
		preheader: heading,
		heading:   heading,
		lines:     lines,
		quote:     quote,
		ctaLabel:  "Open your event →",
		ctaURL:    campaignURL(s.eventURL(ev.ID), campaign),
		logoURL:   s.logoURL(),
		unsubURL:  s.muteLink(ev.HostID, uuidStr(ev.ID)),
	})
	s.notify.Send([]string{host.Email}, subject, body)
}
