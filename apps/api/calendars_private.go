package main

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/clsandbox/api/internal/db"
)

// calendars_private.go - Apple's PRIVATE calendar integration (nothing is
// published anywhere): iCloud has no calendar OAuth; the supported private
// path is CalDAV with an APP-SPECIFIC password the user mints at
// appleid.apple.com (the same mechanism Fantastical et al. use). Stored
// AES-GCM encrypted like the OAuth tokens; read-only use against the fixed
// host caldav.icloud.com.

// ============================ apple caldav ============================

const caldavBase = "https://caldav.icloud.com"

// handleAppleCalDAVConnect validates the Apple ID + app-specific password by
// running principal discovery, then stores the connection (password encrypted).
func (s *server) handleAppleCalDAVConnect(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		AppleID     string `json:"apple_id"`
		AppPassword string `json:"app_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.AppleID = strings.TrimSpace(in.AppleID)
	in.AppPassword = strings.TrimSpace(in.AppPassword)
	if len(in.AppleID) > 120 || len(in.AppPassword) > 100 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "credentials too long"})
		return
	}
	if in.AppleID == "" || (in.AppPassword == "" && !s.calendar.stub()) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "Apple ID and app-specific password are required"})
		return
	}
	if !s.calendar.stub() {
		if _, err := caldavPrincipal(r.Context(), in.AppleID, in.AppPassword); err != nil {
			s.logger.Info("caldav validate failed", "err", err)
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "Apple rejected those credentials - use an app-specific password from appleid.apple.com, not your main password"})
			return
		}
	}
	enc, err := s.calendar.encrypt(in.AppPassword)
	if err != nil {
		s.internal(w, "encrypt caldav password", err)
		return
	}
	conn, err := s.queries.UpsertCalendarConnection(r.Context(), db.UpsertCalendarConnectionParams{
		UserID: uid, Provider: "apple_caldav", AccountLabel: in.AppleID, AccessToken: enc,
	})
	if err != nil {
		s.internal(w, "store caldav connection", err)
		return
	}
	s.analytics.Capture(uid, "calendar_connected", map[string]any{"provider": "apple_caldav"})
	writeJSON(w, http.StatusCreated, toConnectionView(conn))
}

// --- CalDAV plumbing (stdlib XML; fixed host, so no SSRF surface) ---

type davMultistatus struct {
	Responses []struct {
		Href  string `xml:"href"`
		Props []struct {
			Principal    string   `xml:"current-user-principal>href"`
			CalendarHome string   `xml:"calendar-home-set>href"`
			ResourceType []string `xml:"resourcetype>calendar"`
			CalendarData string   `xml:"calendar-data"`
		} `xml:"propstat>prop"`
	} `xml:"response"`
}

func caldavDo(ctx context.Context, method, u, appleID, password, depth, body string) (*davMultistatus, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(appleID, password)
	req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	req.Header.Set("Depth", depth)
	resp, err := calendarHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("caldav %s %s: %s", method, u, resp.Status)
	}
	var ms davMultistatus
	if err := xml.NewDecoder(io.LimitReader(resp.Body, maxICalBytes)).Decode(&ms); err != nil {
		return nil, err
	}
	return &ms, nil
}

// caldavPrincipal resolves the account's principal path (also the credential check).
func caldavPrincipal(ctx context.Context, appleID, password string) (string, error) {
	ms, err := caldavDo(ctx, "PROPFIND", caldavBase+"/", appleID, password, "0",
		`<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`)
	if err != nil {
		return "", err
	}
	for _, r := range ms.Responses {
		for _, p := range r.Props {
			if p.Principal != "" {
				return p.Principal, nil
			}
		}
	}
	return "", fmt.Errorf("no principal in response")
}

func caldavAbs(href string) string {
	if strings.HasPrefix(href, "http") {
		return href
	}
	return caldavBase + href
}

// fetchAppleCalDAVEvents walks principal → calendar home → calendars, then
// pulls each calendar's events in the window via a calendar-query REPORT.
func (s *server) fetchAppleCalDAVEvents(ctx context.Context, c db.CalendarConnection, from, to time.Time) ([]importedEvent, error) {
	password, err := s.calendar.decrypt(c.AccessToken)
	if err != nil {
		return nil, err
	}
	appleID := c.AccountLabel
	principal, err := caldavPrincipal(ctx, appleID, password)
	if err != nil {
		return nil, err
	}
	ms, err := caldavDo(ctx, "PROPFIND", caldavAbs(principal), appleID, password, "0",
		`<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><C:calendar-home-set/></prop></propfind>`)
	if err != nil {
		return nil, err
	}
	home := ""
	for _, r := range ms.Responses {
		for _, p := range r.Props {
			if p.CalendarHome != "" {
				home = p.CalendarHome
			}
		}
	}
	if home == "" {
		return nil, fmt.Errorf("no calendar home")
	}
	ms, err = caldavDo(ctx, "PROPFIND", caldavAbs(home), appleID, password, "1",
		`<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`)
	if err != nil {
		return nil, err
	}
	var calendars []string
	for _, r := range ms.Responses {
		for _, p := range r.Props {
			if len(p.ResourceType) > 0 {
				calendars = append(calendars, r.Href)
			}
		}
	}
	if len(calendars) > 10 {
		calendars = calendars[:10] // sanity cap; iCloud accounts rarely exceed this
	}
	report := fmt.Sprintf(`<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="%s" end="%s"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`, from.UTC().Format("20060102T150405Z"), to.UTC().Format("20060102T150405Z"))
	var out []importedEvent
	for _, cal := range calendars {
		ms, err := caldavDo(ctx, "REPORT", caldavAbs(cal), appleID, password, "1", report)
		if err != nil {
			continue // one broken calendar shouldn't sink the rest
		}
		for _, r := range ms.Responses {
			for _, p := range r.Props {
				if p.CalendarData == "" {
					continue
				}
				evs, perr := parseICal(strings.NewReader(p.CalendarData), from, to)
				if perr != nil {
					continue
				}
				for i := range evs {
					evs[i].Provider = "apple_caldav"
				}
				out = append(out, evs...)
			}
		}
	}
	return out, nil
}
