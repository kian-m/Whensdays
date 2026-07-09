package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// calendars_private.go - the two PRIVATE calendar integrations (nothing is
// published anywhere):
//
//   Apple CalDAV  - iCloud has no calendar OAuth; the supported private path
//                   is CalDAV with an APP-SPECIFIC password the user mints at
//                   appleid.apple.com (the same mechanism Fantastical et al.
//                   use). Stored AES-GCM encrypted like the OAuth tokens;
//                   read-only use against the fixed host caldav.icloud.com.
//   Outlook       - Microsoft Graph OAuth (Calendars.Read), a twin of the
//                   Google flow. Dormant unless MS_OAUTH_CLIENT_ID/SECRET are
//                   set (the web hides the button via outlook_enabled).

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

// ============================ outlook ============================

// handleOutlookConnect mirrors the Google connect: stub short-circuits,
// unconfigured returns 503, otherwise hands back the consent URL.
func (s *server) handleOutlookConnect(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	if s.calendar.stub() {
		if _, err := s.queries.UpsertCalendarConnection(r.Context(), db.UpsertCalendarConnectionParams{
			UserID: uid, Provider: "outlook", AccountLabel: "demo@outlook.com",
		}); err != nil {
			s.internal(w, "stub outlook connect", err)
			return
		}
		s.analytics.Capture(uid, "calendar_connected", map[string]any{"provider": "outlook", "mode": "stub"})
		writeJSON(w, http.StatusOK, map[string]string{"auth_url": s.calendar.returnURL("outlook")})
		return
	}
	if s.calendar.msID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "outlook calendar is not configured"})
		return
	}
	q := url.Values{
		"client_id":     {s.calendar.msID},
		"redirect_uri":  {s.calendar.outlookRedirectURI()},
		"response_type": {"code"},
		"scope":         {"offline_access User.Read Calendars.Read"},
		"state":         {s.calendar.signState(uid)},
	}
	writeJSON(w, http.StatusOK, map[string]string{"auth_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + q.Encode()})
}

// handleOutlookCallback - unauthenticated like the Google one (Microsoft
// redirects the browser bare); identity rides in the signed state.
func (s *server) handleOutlookCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("error") != "" {
		http.Redirect(w, r, s.calendar.returnURL("outlook")+"&status=denied", http.StatusFound)
		return
	}
	uid, ok := s.calendar.verifyState(q.Get("state"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid or expired state"})
		return
	}
	tok, err := s.exchangeOutlookCode(r.Context(), q.Get("code"))
	if err != nil {
		s.logger.Error("outlook token exchange", "err", err)
		http.Redirect(w, r, s.calendar.returnURL("outlook")+"&status=error", http.StatusFound)
		return
	}
	access, _ := s.calendar.encrypt(tok.AccessToken)
	refresh, _ := s.calendar.encrypt(tok.RefreshToken)
	if _, err := s.queries.UpsertCalendarConnection(r.Context(), db.UpsertCalendarConnectionParams{
		UserID:       uid,
		Provider:     "outlook",
		AccountLabel: tok.Email,
		AccessToken:  access,
		RefreshToken: refresh,
		TokenExpiry:  pgtype.Timestamptz{Time: tok.Expiry, Valid: !tok.Expiry.IsZero()},
	}); err != nil {
		s.logger.Error("store outlook connection", "err", err)
		http.Redirect(w, r, s.calendar.returnURL("outlook")+"&status=error", http.StatusFound)
		return
	}
	s.analytics.Capture(uid, "calendar_connected", map[string]any{"provider": "outlook"})
	http.Redirect(w, r, s.calendar.returnURL("outlook"), http.StatusFound)
}

func (s *server) exchangeOutlookCode(ctx context.Context, code string) (googleToken, error) {
	form := url.Values{
		"client_id":     {s.calendar.msID},
		"client_secret": {s.calendar.msSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {s.calendar.outlookRedirectURI()},
	}
	tok, err := postOutlookToken(ctx, form)
	if err != nil {
		return tok, err
	}
	// Label with the account's UPN (Graph /me) - best effort.
	if req, rerr := http.NewRequestWithContext(ctx, http.MethodGet, "https://graph.microsoft.com/v1.0/me", nil); rerr == nil {
		req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		if resp, derr := calendarHTTP.Do(req); derr == nil {
			defer resp.Body.Close()
			var me struct {
				UserPrincipalName string `json:"userPrincipalName"`
				Mail              string `json:"mail"`
			}
			if json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&me) == nil {
				if me.Mail != "" {
					tok.Email = me.Mail
				} else if me.UserPrincipalName != "" {
					tok.Email = me.UserPrincipalName
				}
			}
		}
	}
	if tok.Email == "" {
		tok.Email = "Outlook account"
	}
	return tok, nil
}

func postOutlookToken(ctx context.Context, form url.Values) (googleToken, error) {
	var tok googleToken
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://login.microsoftonline.com/common/oauth2/v2.0/token", strings.NewReader(form.Encode()))
	if err != nil {
		return tok, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := calendarHTTP.Do(req)
	if err != nil {
		return tok, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return tok, fmt.Errorf("outlook token: %s: %s", resp.Status, truncate(string(body), 200))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return tok, err
	}
	tok.AccessToken = raw.AccessToken
	tok.RefreshToken = raw.RefreshToken
	if raw.ExpiresIn > 0 {
		tok.Expiry = time.Now().Add(time.Duration(raw.ExpiresIn) * time.Second)
	}
	return tok, nil
}

// ensureOutlookAccess returns a live access token, refreshing when expired
// (mirrors ensureGoogleAccess).
func (s *server) ensureOutlookAccess(ctx context.Context, c db.CalendarConnection) (string, error) {
	access, err := s.calendar.decrypt(c.AccessToken)
	if err != nil {
		return "", err
	}
	if c.TokenExpiry.Valid && time.Now().Before(c.TokenExpiry.Time.Add(-2*time.Minute)) {
		return access, nil
	}
	refresh, err := s.calendar.decrypt(c.RefreshToken)
	if err != nil || refresh == "" {
		return access, nil // no refresh token - try the stored access token
	}
	tok, err := postOutlookToken(ctx, url.Values{
		"client_id":     {s.calendar.msID},
		"client_secret": {s.calendar.msSecret},
		"refresh_token": {refresh},
		"grant_type":    {"refresh_token"},
	})
	if err != nil {
		return "", err
	}
	encA, _ := s.calendar.encrypt(tok.AccessToken)
	encR := c.RefreshToken
	if tok.RefreshToken != "" {
		encR, _ = s.calendar.encrypt(tok.RefreshToken)
	}
	_, _ = s.queries.UpsertCalendarConnection(ctx, db.UpsertCalendarConnectionParams{
		UserID: c.UserID, Provider: "outlook", AccountLabel: c.AccountLabel,
		AccessToken: encA, RefreshToken: encR,
		TokenExpiry: pgtype.Timestamptz{Time: tok.Expiry, Valid: !tok.Expiry.IsZero()},
	})
	return tok.AccessToken, nil
}

// fetchOutlookEvents pulls the window via Graph calendarView (expanded
// occurrences, UTC times).
func (s *server) fetchOutlookEvents(ctx context.Context, c db.CalendarConnection, from, to time.Time) ([]importedEvent, error) {
	access, err := s.ensureOutlookAccess(ctx, c)
	if err != nil {
		return nil, err
	}
	u := "https://graph.microsoft.com/v1.0/me/calendarView?" + url.Values{
		"startDateTime": {from.UTC().Format(time.RFC3339)},
		"endDateTime":   {to.UTC().Format(time.RFC3339)},
		"$select":       {"subject,start,end,location"},
		"$top":          {"100"},
	}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Prefer", `outlook.timezone="UTC"`)
	resp, err := calendarHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("graph calendarView: %s", resp.Status)
	}
	var raw struct {
		Value []struct {
			Subject string `json:"subject"`
			Start   struct {
				DateTime string `json:"dateTime"`
			} `json:"start"`
			End struct {
				DateTime string `json:"dateTime"`
			} `json:"end"`
			Location struct {
				DisplayName string `json:"displayName"`
			} `json:"location"`
		} `json:"value"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&raw); err != nil {
		return nil, err
	}
	parse := func(v string) time.Time {
		t, err := time.Parse("2006-01-02T15:04:05.9999999", v)
		if err != nil {
			return time.Time{}
		}
		return t.UTC()
	}
	var out []importedEvent
	for _, v := range raw.Value {
		st := parse(v.Start.DateTime)
		if st.IsZero() {
			continue
		}
		ev := importedEvent{Provider: "outlook", Title: v.Subject, StartsAt: st, Location: v.Location.DisplayName}
		if et := parse(v.End.DateTime); !et.IsZero() {
			ev.EndsAt = &et
		}
		if ev.Title == "" {
			ev.Title = "(busy)"
		}
		out = append(out, ev)
	}
	return out, nil
}
