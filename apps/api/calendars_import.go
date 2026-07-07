package main

import (
	"bufio"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

// calendars_import.go is the import half of the calendar feature: connect a
// Google calendar (OAuth 2.0) or an Apple iCloud published .ics URL, read-only,
// to display the user's own commitments. Display only — imports never change
// scheduler availability/voting.
//
// All external providers are bypassed when CALENDAR_MODE=stub (hermetic E2E),
// mirroring AUTH_MODE=dev: connecting seeds a fake connection + fixed events.

const (
	importWindowDays = 30
	maxICalBytes     = 5 << 20 // 5 MiB cap on a fetched .ics body
	stateTTL         = 10 * time.Minute
)

// calendarHTTP is a bounded client for all outbound calendar calls.
var calendarHTTP = safeHTTPClient(10 * time.Second)

// --- config ---

// calendarConfig holds calendar-import settings, read from env in main.go.
type calendarConfig struct {
	mode         string // "stub" bypasses real providers for hermetic E2E
	googleID     string
	googleSecret string
	appOrigin    string // e.g. https://app.example.com; redirect + post-auth target
	key          []byte // 32-byte AES-GCM / HMAC key, or nil in dev/stub
}

func loadCalendarConfig(logger *slog.Logger) calendarConfig {
	c := calendarConfig{
		mode:         os.Getenv("CALENDAR_MODE"),
		googleID:     os.Getenv("GOOGLE_OAUTH_CLIENT_ID"),
		googleSecret: os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
		appOrigin:    strings.TrimRight(os.Getenv("APP_ORIGIN"), "/"),
	}
	if raw := os.Getenv("CALENDAR_TOKEN_KEY"); raw != "" {
		if k, err := base64.StdEncoding.DecodeString(raw); err == nil && len(k) == 32 {
			c.key = k
		} else {
			logger.Warn("CALENDAR_TOKEN_KEY invalid (want base64 of 32 bytes) — OAuth tokens will NOT be encrypted at rest")
		}
	}
	if c.mode == "stub" {
		logger.Warn("CALENDAR_MODE=stub: calendar providers are stubbed — do not use in production")
	}
	return c
}

func (c calendarConfig) stub() bool { return c.mode == "stub" }

// returnURL is where the browser lands after a connect attempt.
func (c calendarConfig) returnURL(provider string) string {
	return c.appOrigin + "/profile?connected=" + provider
}

func (c calendarConfig) redirectURI() string {
	return c.appOrigin + "/api/calendar/google/callback"
}

// --- token encryption (AES-256-GCM, stdlib) ---

// encrypt returns "enc:<base64>" ciphertext, or the plaintext unchanged when no
// key is configured (dev/stub) or the value is empty.
func (c calendarConfig) encrypt(plaintext string) (string, error) {
	if len(c.key) == 0 || plaintext == "" {
		return plaintext, nil
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return "enc:" + base64.StdEncoding.EncodeToString(ct), nil
}

// decrypt reverses encrypt; values without the "enc:" prefix pass through (so a
// key can be added later without breaking older plaintext rows).
func (c calendarConfig) decrypt(s string) (string, error) {
	if !strings.HasPrefix(s, "enc:") {
		return s, nil
	}
	if len(c.key) == 0 {
		return "", errors.New("encrypted token but no CALENDAR_TOKEN_KEY")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, "enc:"))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	return string(pt), err
}

// --- OAuth state (CSRF + identity binding for the unauthenticated callback) ---

func (c calendarConfig) hmacKey() []byte {
	if len(c.key) > 0 {
		return c.key
	}
	return []byte("dev-calendar-state-key") // dev/stub only
}

// signState binds the userID and an expiry into a tamper-proof token. The OAuth
// callback is unauthenticated (Google redirects the browser with no bearer), so
// the user identity rides here instead.
func (c calendarConfig) signState(userID string) string {
	payload := userID + "|" + strconv.FormatInt(time.Now().Add(stateTTL).Unix(), 10)
	mac := hmac.New(sha256.New, c.hmacKey())
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(mac.Sum(nil))
}

func (c calendarConfig) verifyState(state string) (string, bool) {
	dot := strings.LastIndex(state, ".")
	if dot < 0 {
		return "", false
	}
	payloadB64, sig := state[:dot], state[dot+1:]
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return "", false
	}
	mac := hmac.New(sha256.New, c.hmacKey())
	mac.Write(payload)
	if !hmac.Equal([]byte(sig), []byte(hex.EncodeToString(mac.Sum(nil)))) {
		return "", false
	}
	parts := strings.SplitN(string(payload), "|", 2)
	if len(parts) != 2 {
		return "", false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	return parts[0], true
}

// --- response shapes ---

// connectionView is the safe, token-free projection returned to clients.
type connectionView struct {
	Provider     string    `json:"provider"`
	AccountLabel string    `json:"account_label"`
	CreatedAt    time.Time `json:"created_at"`
}

func toConnectionView(c db.CalendarConnection) connectionView {
	return connectionView{Provider: c.Provider, AccountLabel: c.AccountLabel, CreatedAt: c.CreatedAt.Time}
}

// importedEvent is one upcoming event from a connected calendar (display only).
type importedEvent struct {
	Provider string     `json:"provider"`
	Title    string     `json:"title"`
	StartsAt time.Time  `json:"starts_at"`
	EndsAt   *time.Time `json:"ends_at,omitempty"`
	AllDay   bool       `json:"all_day"`
	Location string     `json:"location"`
}

// ============================ handlers ============================

func (s *server) handleListCalendarConnections(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	conns, err := s.queries.ListCalendarConnections(r.Context(), uid)
	if err != nil {
		s.internal(w, "list calendar connections", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": connectionViews(conns)})
}

func connectionViews(conns []db.CalendarConnection) []connectionView {
	out := make([]connectionView, 0, len(conns))
	for _, c := range conns {
		out = append(out, toConnectionView(c))
	}
	return out
}

// handleGoogleConnect returns the URL the browser should visit to grant access.
// In stub mode it fakes a successful connection and points back at the app.
func (s *server) handleGoogleConnect(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	if s.calendar.stub() {
		if _, err := s.queries.UpsertCalendarConnection(r.Context(), db.UpsertCalendarConnectionParams{
			UserID: uid, Provider: "google", AccountLabel: "demo@gmail.com",
		}); err != nil {
			s.internal(w, "stub google connect", err)
			return
		}
		s.analytics.Capture(uid, "calendar_connected", map[string]any{"provider": "google", "mode": "stub"})
		writeJSON(w, http.StatusOK, map[string]string{"auth_url": s.calendar.returnURL("google")})
		return
	}
	if s.calendar.googleID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "google calendar is not configured"})
		return
	}
	q := url.Values{
		"client_id":     {s.calendar.googleID},
		"redirect_uri":  {s.calendar.redirectURI()},
		"response_type": {"code"},
		"scope":         {"https://www.googleapis.com/auth/calendar.readonly openid email"},
		"access_type":   {"offline"},
		"prompt":        {"consent"},
		"state":         {s.calendar.signState(uid)},
	}
	writeJSON(w, http.StatusOK, map[string]string{"auth_url": "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode()})
}

// handleGoogleCallback is the OAuth redirect target. NOT behind auth — Google
// sends the browser here with no bearer, so identity comes from the signed state.
func (s *server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("error") != "" {
		http.Redirect(w, r, s.calendar.returnURL("google")+"&status=denied", http.StatusFound)
		return
	}
	uid, ok := s.calendar.verifyState(q.Get("state"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid or expired state"})
		return
	}
	tok, err := s.exchangeGoogleCode(r.Context(), q.Get("code"))
	if err != nil {
		s.logger.Error("google token exchange", "err", err)
		http.Redirect(w, r, s.calendar.returnURL("google")+"&status=error", http.StatusFound)
		return
	}
	access, _ := s.calendar.encrypt(tok.AccessToken)
	refresh, _ := s.calendar.encrypt(tok.RefreshToken)
	if _, err := s.queries.UpsertCalendarConnection(r.Context(), db.UpsertCalendarConnectionParams{
		UserID:       uid,
		Provider:     "google",
		AccountLabel: tok.Email,
		AccessToken:  access,
		RefreshToken: refresh,
		TokenExpiry:  pgtype.Timestamptz{Time: tok.Expiry, Valid: !tok.Expiry.IsZero()},
	}); err != nil {
		s.logger.Error("store google connection", "err", err)
		http.Redirect(w, r, s.calendar.returnURL("google")+"&status=error", http.StatusFound)
		return
	}
	s.analytics.Capture(uid, "calendar_connected", map[string]any{"provider": "google"})
	http.Redirect(w, r, s.calendar.returnURL("google"), http.StatusFound)
}

// handleAppleConnect stores a published iCloud .ics URL (webcal:// or https://).
func (s *server) handleAppleConnect(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	var in struct {
		IcalURL string `json:"ical_url"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	u := normalizeICalURL(in.IcalURL)
	if !s.calendar.stub() {
		if err := validateExternalURL(u); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "invalid calendar URL"})
			return
		}
	}
	label := "Apple Calendar"
	if pu, err := url.Parse(u); err == nil && pu.Host != "" {
		label = pu.Host
	}
	conn, err := s.queries.UpsertCalendarConnection(r.Context(), db.UpsertCalendarConnectionParams{
		UserID: uid, Provider: "apple_ical", AccountLabel: label, IcalUrl: u,
	})
	if err != nil {
		s.internal(w, "store apple connection", err)
		return
	}
	s.analytics.Capture(uid, "calendar_connected", map[string]any{"provider": "apple_ical"})
	writeJSON(w, http.StatusCreated, toConnectionView(conn))
}

func (s *server) handleDisconnectCalendar(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	provider := r.PathValue("provider")
	if !oneOf(provider, "google", "apple_ical") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown provider"})
		return
	}
	if err := s.queries.DeleteCalendarConnection(r.Context(), db.DeleteCalendarConnectionParams{UserID: uid, Provider: provider}); err != nil {
		s.internal(w, "disconnect calendar", err)
		return
	}
	s.analytics.Capture(uid, "calendar_disconnected", map[string]any{"provider": provider})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCalendarEvents returns the user's upcoming events across all connections,
// merged and sorted. Per-connection fetch errors are logged and skipped so one
// broken calendar doesn't blank the whole view.
func (s *server) handleCalendarEvents(w http.ResponseWriter, r *http.Request) {
	uid, _ := userIDFrom(r.Context())
	conns, err := s.queries.ListCalendarConnections(r.Context(), uid)
	if err != nil {
		s.internal(w, "list calendar connections", err)
		return
	}
	from := time.Now()
	to := from.AddDate(0, 0, importWindowDays)

	var events []importedEvent
	if s.calendar.stub() {
		events = stubImportedEvents(conns)
	} else {
		for _, c := range conns {
			evs, err := s.fetchConnectionEvents(r.Context(), c, from, to)
			if err != nil {
				s.logger.Error("fetch calendar events", "provider", c.Provider, "err", err)
				continue
			}
			events = append(events, evs...)
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].StartsAt.Before(events[j].StartsAt) })
	if events == nil {
		events = []importedEvent{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": connectionViews(conns), "events": events})
}

func (s *server) fetchConnectionEvents(ctx context.Context, c db.CalendarConnection, from, to time.Time) ([]importedEvent, error) {
	switch c.Provider {
	case "google":
		return s.fetchGoogleEvents(ctx, c, from, to)
	case "apple_ical":
		return fetchICalEvents(ctx, c.IcalUrl, from, to)
	default:
		return nil, fmt.Errorf("unknown provider %q", c.Provider)
	}
}

// ============================ google ============================

type googleToken struct {
	AccessToken  string
	RefreshToken string
	Expiry       time.Time
	Email        string
}

func (s *server) exchangeGoogleCode(ctx context.Context, code string) (googleToken, error) {
	form := url.Values{
		"code":          {code},
		"client_id":     {s.calendar.googleID},
		"client_secret": {s.calendar.googleSecret},
		"redirect_uri":  {s.calendar.redirectURI()},
		"grant_type":    {"authorization_code"},
	}
	return s.postGoogleToken(ctx, form)
}

func (s *server) postGoogleToken(ctx context.Context, form url.Values) (googleToken, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return googleToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := calendarHTTP.Do(req)
	if err != nil {
		return googleToken{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return googleToken{}, fmt.Errorf("google token endpoint: %s: %s", resp.Status, string(body))
	}
	var tr struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		IDToken      string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return googleToken{}, err
	}
	tok := googleToken{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		Email:        emailFromIDToken(tr.IDToken),
	}
	if tr.ExpiresIn > 0 {
		tok.Expiry = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	}
	return tok, nil
}

// emailFromIDToken pulls the email claim out of a Google id_token (a JWT).
// Safe without signature verification: it arrived directly from Google over TLS.
func emailFromIDToken(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.Email
}

// fetchGoogleEvents lists primary-calendar events in [from,to], refreshing the
// access token first if it has expired.
func (s *server) fetchGoogleEvents(ctx context.Context, c db.CalendarConnection, from, to time.Time) ([]importedEvent, error) {
	access, err := s.ensureGoogleAccess(ctx, c)
	if err != nil {
		return nil, err
	}
	q := url.Values{
		"timeMin":      {from.UTC().Format(time.RFC3339)},
		"timeMax":      {to.UTC().Format(time.RFC3339)},
		"singleEvents": {"true"},
		"orderBy":      {"startTime"},
		"maxResults":   {"50"},
	}
	endpoint := "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	resp, err := calendarHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxICalBytes))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google events: %s", resp.Status)
	}
	var gr struct {
		Items []struct {
			Summary  string `json:"summary"`
			Location string `json:"location"`
			Start    struct {
				DateTime string `json:"dateTime"`
				Date     string `json:"date"`
			} `json:"start"`
			End struct {
				DateTime string `json:"dateTime"`
				Date     string `json:"date"`
			} `json:"end"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &gr); err != nil {
		return nil, err
	}
	out := make([]importedEvent, 0, len(gr.Items))
	for _, it := range gr.Items {
		ev := importedEvent{Provider: "google", Title: it.Summary, Location: it.Location}
		if it.Start.DateTime != "" {
			if t, err := time.Parse(time.RFC3339, it.Start.DateTime); err == nil {
				ev.StartsAt = t
			}
		} else if it.Start.Date != "" {
			if t, err := time.Parse("2006-01-02", it.Start.Date); err == nil {
				ev.StartsAt, ev.AllDay = t, true
			}
		}
		if it.End.DateTime != "" {
			if t, err := time.Parse(time.RFC3339, it.End.DateTime); err == nil {
				ev.EndsAt = &t
			}
		}
		if ev.Title == "" {
			ev.Title = "(busy)"
		}
		out = append(out, ev)
	}
	return out, nil
}

// ensureGoogleAccess returns a valid access token, refreshing + persisting a new
// one if the stored token has expired.
func (s *server) ensureGoogleAccess(ctx context.Context, c db.CalendarConnection) (string, error) {
	access, err := s.calendar.decrypt(c.AccessToken)
	if err != nil {
		return "", err
	}
	if c.TokenExpiry.Valid && time.Now().Before(c.TokenExpiry.Time.Add(-1*time.Minute)) {
		return access, nil
	}
	refresh, err := s.calendar.decrypt(c.RefreshToken)
	if err != nil || refresh == "" {
		return access, nil // no refresh token; try the existing access token
	}
	tok, err := s.postGoogleToken(ctx, url.Values{
		"client_id":     {s.calendar.googleID},
		"client_secret": {s.calendar.googleSecret},
		"refresh_token": {refresh},
		"grant_type":    {"refresh_token"},
	})
	if err != nil {
		return "", err
	}
	encAccess, _ := s.calendar.encrypt(tok.AccessToken)
	_ = s.queries.UpdateCalendarTokens(ctx, db.UpdateCalendarTokensParams{
		UserID:       c.UserID,
		Provider:     c.Provider,
		AccessToken:  encAccess,
		RefreshToken: c.RefreshToken, // refresh token is reused
		TokenExpiry:  pgtype.Timestamptz{Time: tok.Expiry, Valid: !tok.Expiry.IsZero()},
	})
	return tok.AccessToken, nil
}

// ============================ apple / ical ============================

// normalizeICalURL upgrades a webcal:// subscription URL to https://.
func normalizeICalURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "webcal://") {
		return "https://" + strings.TrimPrefix(raw, "webcal://")
	}
	return raw
}

// validateExternalURL is the SSRF guard: https only, and no resolved IP may be
// loopback/private/link-local/unspecified.
func validateExternalURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return errors.New("must be an https URL")
	}
	ips, err := net.LookupIP(u.Hostname())
	if err != nil || len(ips) == 0 {
		return errors.New("cannot resolve host")
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return errors.New("host not allowed")
		}
	}
	return nil
}

// fetchICalEvents downloads and parses a published .ics calendar, returning the
// VEVENTs whose start falls within [from,to].
func fetchICalEvents(ctx context.Context, rawURL string, from, to time.Time) ([]importedEvent, error) {
	if err := validateExternalURL(rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := calendarHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ical fetch: %s", resp.Status)
	}
	return parseICal(io.LimitReader(resp.Body, maxICalBytes), from, to)
}

// parseICal is a minimal iCalendar reader: it unfolds continuation lines and
// extracts SUMMARY/LOCATION/DTSTART/DTEND from each VEVENT. Good enough for
// read-only display of typical Google/Apple feeds.
func parseICal(r io.Reader, from, to time.Time) ([]importedEvent, error) {
	var out []importedEvent
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)

	var lines []string
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && len(lines) > 0 {
			lines[len(lines)-1] += line[1:] // unfold
			continue
		}
		lines = append(lines, line)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}

	var cur *importedEvent
	for _, line := range lines {
		switch {
		case line == "BEGIN:VEVENT":
			cur = &importedEvent{Provider: "apple_ical"}
		case line == "END:VEVENT":
			if cur != nil && !cur.StartsAt.IsZero() && !cur.StartsAt.Before(from) && cur.StartsAt.Before(to) {
				if cur.Title == "" {
					cur.Title = "(busy)"
				}
				out = append(out, *cur)
			}
			cur = nil
		default:
			if cur == nil {
				continue
			}
			name, params, value := splitICalLine(line)
			switch name {
			case "SUMMARY":
				cur.Title = unescapeICalText(value)
			case "LOCATION":
				cur.Location = unescapeICalText(value)
			case "DTSTART":
				if t, allDay, ok := parseICalTime(params, value); ok {
					cur.StartsAt, cur.AllDay = t, allDay
				}
			case "DTEND":
				if t, _, ok := parseICalTime(params, value); ok {
					cur.EndsAt = &t
				}
			}
		}
	}
	return out, nil
}

// splitICalLine breaks "DTSTART;TZID=...:VALUE" into name, params, value.
func splitICalLine(line string) (name, params, value string) {
	colon := strings.Index(line, ":")
	if colon < 0 {
		return "", "", ""
	}
	key, value := line[:colon], line[colon+1:]
	if semi := strings.Index(key, ";"); semi >= 0 {
		return strings.ToUpper(key[:semi]), key[semi+1:], value
	}
	return strings.ToUpper(key), "", value
}

func parseICalTime(params, value string) (time.Time, bool, bool) {
	// All-day date value, e.g. DTSTART;VALUE=DATE:20260801
	if strings.Contains(strings.ToUpper(params), "VALUE=DATE") || len(value) == 8 {
		if t, err := time.Parse("20060102", value); err == nil {
			return t, true, true
		}
	}
	// UTC, e.g. 20260801T190000Z
	if strings.HasSuffix(value, "Z") {
		if t, err := time.Parse("20060102T150405Z", value); err == nil {
			return t, false, true
		}
	}
	// Floating/local time — treat as UTC for display purposes.
	if t, err := time.Parse("20060102T150405", value); err == nil {
		return t, false, true
	}
	return time.Time{}, false, false
}

func unescapeICalText(s string) string {
	r := strings.NewReplacer(`\n`, "\n", `\N`, "\n", `\,`, ",", `\;`, ";", `\\`, `\`)
	return r.Replace(s)
}

// ============================ stub seed ============================

// stubImportedEvents returns fixed events for the connected providers so the E2E
// (CALENDAR_MODE=stub) is deterministic. Dates are absolute (not now-relative)
// so visual snapshots are stable.
func stubImportedEvents(conns []db.CalendarConnection) []importedEvent {
	connected := map[string]bool{}
	for _, c := range conns {
		connected[c.Provider] = true
	}
	at := func(s string) time.Time { t, _ := time.Parse(time.RFC3339, s); return t }
	all := []importedEvent{
		{Provider: "google", Title: "Dentist appointment", StartsAt: at("2026-08-03T09:00:00Z"), Location: "Downtown Dental"},
		{Provider: "google", Title: "Team standup", StartsAt: at("2026-08-04T15:00:00Z")},
		{Provider: "apple_ical", Title: "Book club", StartsAt: at("2026-08-05T19:30:00Z"), Location: "Maya's place"},
	}
	out := make([]importedEvent, 0, len(all))
	for _, e := range all {
		if connected[e.Provider] {
			out = append(out, e)
		}
	}
	return out
}
