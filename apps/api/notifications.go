package main

import (
	"context"
	"fmt"

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

// eventWhen renders the locked time, or "" if the event has no time yet.
func eventWhen(ev db.Event) string {
	if !ev.StartsAt.Valid {
		return ""
	}
	return ev.StartsAt.Time.Format("Mon Jan 2 · 3:04 PM MST")
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
// message carries its own one-click unsubscribe link) and sends individually.
// build receives that recipient's unsubscribe URL. Returns the recipient count.
func (s *server) broadcastToGoing(ctx context.Context, ev db.Event, subject string, build func(unsub string) emailContent) int {
	if !s.notify.Enabled() {
		return 0
	}
	contacts, err := s.queries.ListGoingAttendeeContacts(ctx, ev.ID)
	if err != nil {
		return 0
	}
	for _, c := range contacts {
		s.notify.Send([]string{c.Email}, subject, renderEmail(build(s.muteLink(c.UserID, uuidStr(ev.ID)))))
	}
	return len(contacts)
}

// notifyFinalized emails every 'going', unmuted attendee once a time is locked in.
func (s *server) notifyFinalized(ctx context.Context, ev db.Event) {
	s.broadcastToGoing(ctx, ev, fmt.Sprintf("It's on — %s is locked in 🎉", ev.Title), func(unsub string) emailContent {
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
	return s.broadcastToGoing(ctx, ev, "Tomorrow: "+ev.Title, func(unsub string) emailContent {
		return emailContent{
			preheader: "Happening soon — don't forget.",
			heading:   ev.Title + " is tomorrow",
			lines:     []string{"Just a heads up — this is coming up soon. See you there!"},
			meta:      eventMeta(ev),
			ctaLabel:  "See the details →",
			ctaURL:    campaignURL(s.eventURL(ev.ID), "reminder"),
			logoURL:   s.logoURL(),
			unsubURL:  unsub,
		}
	})
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
