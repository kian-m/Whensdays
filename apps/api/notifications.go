package main

import (
	"context"
	"fmt"
	"strings"
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
	w := ev.StartsAt.Time.In(eventLocation(ev)).Format("Mon Jan 2 · 3:04 PM MST")
	if ev.EndsAt.Valid {
		w += " – " + ev.EndsAt.Time.In(eventLocation(ev)).Format("3:04 PM")
	}
	return w
}

// eventCover returns the event's cover/GIF for email — https only (mail
// clients strip data: URIs, which is what uploaded covers are).
func eventCover(ev db.Event) string {
	if strings.HasPrefix(ev.PhotoUrl, "https://") {
		return ev.PhotoUrl
	}
	return ""
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

// notifyFinalized announces the locked-in date(s) to EVERYONE meaningfully
// attached: going + maybe attendees AND invited people who haven't answered
// (in a poll most of the group has only voted, not RSVP'd). Declines and mutes
// are respected. Multi-date finalizes list every date.
func (s *server) notifyFinalized(ctx context.Context, ev db.Event, extra []pgtype.Timestamptz) {
	if !s.notify.Enabled() {
		return
	}
	contacts, err := s.queries.ListFinalizeContacts(ctx, ev.ID)
	if err != nil {
		return
	}
	meta := eventMeta(ev)
	heading, line := ev.Title+" has a time 🎉", "Good news — the group landed on a time. Add it to your calendar so it actually happens."
	if len(extra) > 0 {
		heading = fmt.Sprintf("%s has its dates 🎉", ev.Title)
		line = fmt.Sprintf("Good news — the group locked in %d dates. Add them to your calendar so they actually happen.", 1+len(extra))
		loc := eventLocation(ev)
		for _, ts := range extra {
			meta = append(meta, emailMetaRow{"Also", ts.Time.In(loc).Format("Mon Jan 2 · 3:04 PM MST")})
		}
	}
	subject := fmt.Sprintf("It's on — %s is locked in 🎉", ev.Title)
	for _, c := range contacts {
		body := renderEmail(emailContent{
			preheader: "A time is set — here are the details.",
			heading:   heading,
			lines:     []string{line},
			meta:      meta,
			ctaLabel:  "View the plan →",
			ctaURL:    campaignURL(s.eventURL(ev.ID), "finalized"),
			logoURL:   s.logoURL(),
			unsubURL:  s.muteLink(c.UserID, uuidStr(ev.ID)),
			coverURL:  eventCover(ev),
			theme:     ev.Theme,
		})
		s.notify.Send([]string{c.Email}, subject, body)
	}
}

// sendReminders sends tomorrow's reminders with per-recipient DIGESTING: a
// person going to several events tomorrow gets ONE email listing them all,
// instead of a pile of near-identical mails. Returns the recipient count.
func (s *server) sendReminders(ctx context.Context, events []db.Event) int {
	if !s.notify.Enabled() || len(events) == 0 {
		return 0
	}
	type rec struct {
		email  string
		events []db.Event
	}
	byUser := map[string]*rec{}
	order := []string{}
	for _, ev := range events {
		contacts, err := s.queries.ListGoingAttendeeContacts(ctx, ev.ID)
		if err != nil {
			continue
		}
		for _, c := range contacts {
			if byUser[c.UserID] == nil {
				byUser[c.UserID] = &rec{email: c.Email}
				order = append(order, c.UserID)
			}
			byUser[c.UserID].events = append(byUser[c.UserID].events, ev)
		}
	}
	for _, userID := range order {
		r := byUser[userID]
		if len(r.events) == 1 {
			ev := r.events[0]
			body := renderEmail(emailContent{
				preheader: "Happening soon — don't forget.",
				heading:   ev.Title + " is tomorrow",
				lines:     []string{"Just a heads up — this is coming up soon. See you there!"},
				meta:      eventMeta(ev),
				ctaLabel:  "See the details →",
				ctaURL:    campaignURL(s.eventURL(ev.ID), "reminder"),
				moreLabel: "Can't make it anymore?",
				moreURL:   s.rsvpLink(userID, uuidStr(ev.ID), "declined"),
				logoURL:   s.logoURL(),
				unsubURL:  s.muteLink(userID, uuidStr(ev.ID)),
				coverURL:  eventCover(ev),
				theme:     ev.Theme,
			})
			s.notify.Send([]string{r.email}, "Tomorrow: "+ev.Title, body)
			continue
		}
		items := make([]emailItem, 0, len(r.events))
		for _, ev := range r.events {
			items = append(items, emailItem{
				title:   ev.Title,
				when:    eventWhen(ev),
				url:     campaignURL(s.eventURL(ev.ID), "reminder"),
				muteURL: s.muteLink(userID, uuidStr(ev.ID)),
			})
		}
		body := renderEmail(emailContent{
			preheader: "Busy day ahead — here's the lineup.",
			heading:   fmt.Sprintf("You have %d plans tomorrow", len(items)),
			lines:     []string{"Here's everything on your calendar for tomorrow:"},
			items:     items,
			logoURL:   s.logoURL(),
		})
		s.notify.Send([]string{r.email}, fmt.Sprintf("Tomorrow: %d plans", len(items)), body)
	}
	return len(order)
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
		coverURL:  eventCover(ev),
		theme:     ev.Theme,
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
			coverURL:  eventCover(ev),
			theme:     ev.Theme,
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
		coverURL:  eventCover(ev),
		theme:     ev.Theme,
	})
	s.notify.Send([]string{host.Email}, "Plan the next "+ev.Title+"?", body)
}

// --- host-activity digest -----------------------------------------------
//
// Comments and RSVPs do NOT email the host per action — someone flip-flopping
// an RSVP or posting five comments would be spam. Instead each action enqueues
// into notification_queue; a flusher (started from main, every 5 min) drains
// items older than digestWindowMins, collapses them (latest RSVP per person
// wins; comments keep up to a few quotes), and sends ONE digest per host.

const digestWindowMins = 10

// notifyNewComment queues a comment notification for the host.
func (s *server) notifyNewComment(ctx context.Context, ev db.Event, actorID, actorName, text string) {
	s.enqueueActivity(ctx, ev, "comment", actorID, actorName, text)
}

// notifyNewRSVP queues a going-RSVP notification for the host.
func (s *server) notifyNewRSVP(ctx context.Context, ev db.Event, actorID, actorName string) {
	s.enqueueActivity(ctx, ev, "rsvp", actorID, actorName, "")
}

func (s *server) enqueueActivity(ctx context.Context, ev db.Event, kind, actorID, actorName, body string) {
	if !s.notify.Enabled() || actorID == ev.HostID {
		return
	}
	_ = s.queries.EnqueueNotification(ctx, db.EnqueueNotificationParams{
		RecipientID: ev.HostID, EventID: ev.ID, Kind: kind,
		ActorID: actorID, ActorName: actorName, Body: body,
	})
}

// digestLine is one collapsed update inside a digest.
type digestLine struct {
	eventID pgtype.UUID
	text    string
}

// collapseActivity turns raw queue rows into per-recipient digest lines:
// RSVP flip-flops collapse to the latest per (actor, event); comments all
// survive. Pure — unit-tested without a DB.
func collapseActivity(rows []db.DrainDueNotificationsRow) map[string][]digestLine {
	out := map[string][]digestLine{}
	seenRsvp := map[string]bool{} // recipient|event|actor — latest wins (rows scan newest-last, so walk backwards)
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if r.Kind == "rsvp" {
			k := r.RecipientID + "|" + uuidStr(r.EventID) + "|" + r.ActorID
			if seenRsvp[k] {
				continue
			}
			seenRsvp[k] = true
			out[r.RecipientID] = append(out[r.RecipientID], digestLine{r.EventID, "✅ " + r.ActorName + " is going"})
			continue
		}
		text := r.Body
		if len(text) > 120 {
			text = text[:117] + "…"
		}
		if text == "" {
			text = "sent a GIF"
		}
		out[r.RecipientID] = append(out[r.RecipientID], digestLine{r.EventID, "💬 " + r.ActorName + ": " + text})
	}
	// walking backwards reversed the order — restore oldest-first per recipient
	for k := range out {
		lines := out[k]
		for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
			lines[i], lines[j] = lines[j], lines[i]
		}
	}
	return out
}

// startNotificationFlusher drains + sends activity digests on a fixed cadence.
// Safe with multiple instances: DrainDueNotifications claims rows atomically.
func (s *server) startNotificationFlusher(ctx context.Context) {
	if !s.notify.Enabled() {
		return
	}
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.flushActivityDigests(ctx)
		}
	}
}

func (s *server) flushActivityDigests(ctx context.Context) {
	rows, err := s.queries.DrainDueNotifications(ctx, digestWindowMins)
	if err != nil || len(rows) == 0 {
		return
	}
	for recipient, lines := range collapseActivity(rows) {
		// Mute + email checks happen at SEND time (state may have changed while
		// queued). Muted events drop out of the digest.
		prof, perr := s.queries.GetProfile(ctx, recipient)
		if perr != nil || prof.Email == "" {
			continue
		}
		byEvent := map[string][]string{}
		muted := map[string]bool{}
		eventOrder := []pgtype.UUID{}
		for _, ln := range lines {
			k := uuidStr(ln.eventID)
			if _, checked := muted[k]; !checked {
				m, _ := s.queries.IsEventMuted(ctx, db.IsEventMutedParams{EventID: ln.eventID, UserID: recipient})
				muted[k] = m
				if !m {
					eventOrder = append(eventOrder, ln.eventID)
				}
			}
			if muted[k] {
				continue
			}
			byEvent[k] = append(byEvent[k], ln.text)
		}
		items := []emailItem{}
		total := 0
		for _, evID := range eventOrder {
			k := uuidStr(evID)
			if len(byEvent[k]) == 0 {
				continue
			}
			ev, gerr := s.queries.GetEvent(ctx, evID)
			if gerr != nil || ev.Status == "cancelled" {
				continue
			}
			summary := strings.Join(byEvent[k], "  ·  ")
			if len(summary) > 300 {
				summary = summary[:297] + "…"
			}
			items = append(items, emailItem{
				title:   ev.Title,
				when:    summary,
				url:     campaignURL(s.eventURL(ev.ID), "activity"),
				muteURL: s.muteLink(recipient, uuidStr(ev.ID)),
			})
			total += len(byEvent[k])
		}
		if len(items) == 0 {
			continue
		}
		subject := fmt.Sprintf("%d update%s on %s", total, plural(total), items[0].title)
		if len(items) > 1 {
			subject = fmt.Sprintf("%d updates on your events", total)
		}
		body := renderEmail(emailContent{
			preheader: "The latest from your plans.",
			heading:   subject,
			items:     items,
			logoURL:   s.logoURL(),
		})
		s.notify.Send([]string{prof.Email}, subject, body)
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
