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

// notifyFinalized emails every 'going' attendee once a time is locked in.
func (s *server) notifyFinalized(ctx context.Context, ev db.Event) {
	if !s.notify.Enabled() {
		return
	}
	emails, err := s.queries.ListGoingAttendeeEmails(ctx, ev.ID)
	if err != nil || len(emails) == 0 {
		return
	}
	subject := fmt.Sprintf("It's on — %s is locked in 🎉", ev.Title)
	body := renderEmail(emailContent{
		preheader: "A time is set — here are the details.",
		heading:   ev.Title + " has a time 🎉",
		lines:     []string{"Good news — the group landed on a time. Add it to your calendar so it actually happens."},
		meta:      eventMeta(ev),
		ctaLabel:  "View the plan →",
		ctaURL:    campaignURL(s.eventURL(ev.ID), "finalized"),
		logoURL:   s.logoURL(),
	})
	s.notify.Send(emails, subject, body)
}

// notifyReminder emails every 'going' attendee ~24h out (called by the cron).
// Returns the number of recipients (for the cron's telemetry).
func (s *server) notifyReminder(ctx context.Context, ev db.Event) int {
	if !s.notify.Enabled() {
		return 0
	}
	emails, err := s.queries.ListGoingAttendeeEmails(ctx, ev.ID)
	if err != nil || len(emails) == 0 {
		return 0
	}
	body := renderEmail(emailContent{
		preheader: "Happening soon — don't forget.",
		heading:   ev.Title + " is tomorrow",
		lines:     []string{"Just a heads up — this is coming up soon. See you there!"},
		meta:      eventMeta(ev),
		ctaLabel:  "See the details →",
		ctaURL:    campaignURL(s.eventURL(ev.ID), "reminder"),
		logoURL:   s.logoURL(),
	})
	s.notify.Send(emails, "Tomorrow: "+ev.Title, body)
	return len(emails)
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
	})
	s.notify.Send([]string{host.Email}, subject, body)
}
