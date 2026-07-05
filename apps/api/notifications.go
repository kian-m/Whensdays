package main

import (
	"context"
	"fmt"
	"html"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// notifications.go — the transactional-email triggers (growth priority #2).
// All best-effort: failures are logged by the notify client, never surfaced.

func (s *server) eventURL(id pgtype.UUID) string {
	return s.appOrigin + "/e/" + uuidStr(id)
}

// emailBody renders the shared minimal template.
func emailBody(heading, detail, url string) string {
	link := ""
	if url != "/e/"+"" && url != "" {
		link = fmt.Sprintf(`<p><a href="%s">Open the event</a></p>`, url)
	}
	return fmt.Sprintf(`<div style="font-family:sans-serif"><h2>%s</h2><p>%s</p>%s</div>`,
		html.EscapeString(heading), html.EscapeString(detail), link)
}

// notifyFinalized emails every 'going' attendee with an email set.
func (s *server) notifyFinalized(ctx context.Context, ev db.Event) {
	if !s.notify.Enabled() {
		return
	}
	emails, err := s.queries.ListGoingAttendeeEmails(ctx, ev.ID)
	if err != nil || len(emails) == 0 {
		return
	}
	when := ev.StartsAt.Time.Format("Mon Jan 2, 3:04 PM MST")
	s.notify.Send(emails, fmt.Sprintf("%s is locked in 🎉", ev.Title),
		emailBody(ev.Title+" has a time", "It's happening: "+when+".", s.eventURL(ev.ID)))
}

// notifyHost emails the event's host (skipped when actor is the host).
func (s *server) notifyHost(ctx context.Context, ev db.Event, actorID, subject, detail string) {
	if !s.notify.Enabled() || actorID == ev.HostID {
		return
	}
	host, err := s.queries.GetProfile(ctx, ev.HostID)
	if err != nil || host.Email == "" {
		return
	}
	s.notify.Send([]string{host.Email}, subject, emailBody(ev.Title, detail, s.eventURL(ev.ID)))
}
