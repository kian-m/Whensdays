package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/clsandbox/api/internal/db"
)

// calendars.go holds the calendar import/export feature.
//
// Export (this file, Phase A): a finalized event is offered as an RFC 5545
// .ics file so it can be added to Apple/Google/Outlook calendars. The web also
// builds an "Add to Google Calendar" link entirely client-side (no endpoint).
//
// Import (Phase B, below) lets a user connect their Google calendar (OAuth) or
// an Apple iCloud published .ics URL, read-only, to display their commitments.

// exportDuration is how long an exported event is assumed to last: events store
// only starts_at (no end/duration), so we default to two hours. A real
// duration/ends_at column on events is a future enhancement.
const exportDuration = 2 * time.Hour

// icsTimeFmt is the iCalendar UTC timestamp layout (e.g. 20060102T150405Z).
const icsTimeFmt = "20060102T150405Z"

// handleEventICS serves a single finalized event as a downloadable .ics file.
// Access mirrors handleGetEvent: any authenticated user with the event id (the
// invite capability) may fetch it. Only scheduled events with a concrete time
// can be exported.
func (s *server) handleEventICS(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	ev, err := s.queries.GetEvent(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		s.internal(w, "get event for ics", err)
		return
	}
	if ev.Status != "scheduled" || !ev.StartsAt.Valid {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "event has no confirmed time yet"})
		return
	}

	ics := buildICS(ev, time.Now().UTC(), s.ogBaseURL(r)+"/e/"+uuidStr(ev.ID))
	s.analytics.Capture(uid, "event_exported", map[string]any{
		"event_id": uuidStr(ev.ID),
		"format":   "ics",
	})
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	// inline (not attachment): iOS/macOS Safari then open the event preview
	// directly in Calendar instead of routing through the download manager.
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", icsFilename(ev.Title)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(ics))
}

// buildICS renders a one-event VCALENDAR. now stamps DTSTAMP (passed in so the
// output is deterministic in tests). link (the event's invite URL) rides in
// URL: and at the end of DESCRIPTION so every calendar app keeps a way back.
func buildICS(ev db.Event, now time.Time, link string) string {
	start := ev.StartsAt.Time.UTC()
	end := start.Add(exportDuration)
	if ev.EndsAt.Valid {
		end = ev.EndsAt.Time.UTC()
	}

	location := ev.LocationAddress
	if ev.LocationMode == "find_venue" {
		location = "Venue to be decided"
	} else if location == "" {
		location = "Address to come"
	}

	var b strings.Builder
	b.WriteString("BEGIN:VCALENDAR\r\n")
	b.WriteString("VERSION:2.0\r\n")
	b.WriteString("PRODID:-//Whensdays//scheduler//EN\r\n")
	b.WriteString("CALSCALE:GREGORIAN\r\n")
	b.WriteString("METHOD:PUBLISH\r\n")
	b.WriteString("BEGIN:VEVENT\r\n")
	b.WriteString("UID:" + uuidStr(ev.ID) + "@whensdays\r\n")
	b.WriteString("DTSTAMP:" + now.UTC().Format(icsTimeFmt) + "\r\n")
	b.WriteString("DTSTART:" + start.Format(icsTimeFmt) + "\r\n")
	b.WriteString("DTEND:" + end.Format(icsTimeFmt) + "\r\n")
	b.WriteString("SUMMARY:" + icsEscape(ev.Title) + "\r\n")
	desc := ev.Description
	if link != "" {
		if desc != "" {
			desc += "\n\n"
		}
		desc += "RSVP & details: " + link
	}
	if desc != "" {
		b.WriteString("DESCRIPTION:" + icsEscape(desc) + "\r\n")
	}
	if link != "" {
		b.WriteString("URL:" + link + "\r\n")
	}
	b.WriteString("LOCATION:" + icsEscape(location) + "\r\n")
	b.WriteString("END:VEVENT\r\n")
	b.WriteString("END:VCALENDAR\r\n")
	return b.String()
}

// icsEscape escapes a text value per RFC 5545 §3.3.11 (backslash, comma,
// semicolon, and newlines).
func icsEscape(s string) string {
	r := strings.NewReplacer(
		"\\", "\\\\",
		";", "\\;",
		",", "\\,",
		"\r\n", "\\n",
		"\n", "\\n",
		"\r", "\\n",
	)
	return r.Replace(s)
}

// icsFilename turns a title into a safe download filename like "dinner.ics".
func icsFilename(title string) string {
	slug := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r == ' ' || r == '-' || r == '_':
			return '-'
		default:
			return -1
		}
	}, title)
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "event"
	}
	return slug + ".ics"
}
