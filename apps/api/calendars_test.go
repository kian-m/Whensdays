package main

import (
	"strings"
	"testing"
	"time"

	"github.com/clsandbox/api/internal/db"
)

// a deterministic 32-byte key for crypto tests.
var testCalCfg = calendarConfig{key: []byte("0123456789abcdef0123456789abcdef")}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	ct, err := testCalCfg.encrypt("super-secret-token")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ct, "enc:") {
		t.Fatalf("expected enc: prefix, got %q", ct)
	}
	if ct == "super-secret-token" || strings.Contains(ct, "super-secret") {
		t.Fatal("ciphertext leaks plaintext")
	}
	pt, err := testCalCfg.decrypt(ct)
	if err != nil {
		t.Fatal(err)
	}
	if pt != "super-secret-token" {
		t.Fatalf("round-trip mismatch: %q", pt)
	}
}

func TestEncryptNoKeyPassthrough(t *testing.T) {
	var noKey calendarConfig
	ct, _ := noKey.encrypt("hello")
	if ct != "hello" {
		t.Fatalf("no-key encrypt should passthrough, got %q", ct)
	}
	pt, _ := noKey.decrypt("hello")
	if pt != "hello" {
		t.Fatalf("no-key decrypt should passthrough, got %q", pt)
	}
}

func TestDecryptTamperedFails(t *testing.T) {
	ct, _ := testCalCfg.encrypt("token")
	if _, err := testCalCfg.decrypt(ct + "ff"); err == nil {
		t.Fatal("tampered ciphertext should fail to decrypt")
	}
}

func TestSignVerifyState(t *testing.T) {
	state := testCalCfg.signState("user-123")
	uid, ok := testCalCfg.verifyState(state)
	if !ok || uid != "user-123" {
		t.Fatalf("verifyState = %q,%v want user-123,true", uid, ok)
	}
	if _, ok := testCalCfg.verifyState(state + "tamper"); ok {
		t.Fatal("tampered state should not verify")
	}
	if _, ok := testCalCfg.verifyState("garbage"); ok {
		t.Fatal("garbage state should not verify")
	}
	// A different key must reject the signature.
	other := calendarConfig{key: []byte("ffffffffffffffffffffffffffffffff")}
	if _, ok := other.verifyState(state); ok {
		t.Fatal("state signed with a different key should not verify")
	}
}

func TestValidateExternalURL(t *testing.T) {
	bad := []string{
		"http://example.com/cal.ics",  // not https
		"https://127.0.0.1/cal.ics",   // loopback
		"https://10.0.0.1/cal.ics",    // private
		"https://169.254.0.1/cal.ics", // link-local
		"ftp://example.com/cal.ics",
		"not a url",
	}
	for _, u := range bad {
		if err := validateExternalURL(u); err == nil {
			t.Errorf("validateExternalURL(%q) should fail", u)
		}
	}
	// A public IP literal needs no DNS and should pass the guard.
	if err := validateExternalURL("https://8.8.8.8/cal.ics"); err != nil {
		t.Errorf("public IP should pass SSRF guard, got %v", err)
	}
}

func TestNormalizeICalURL(t *testing.T) {
	if got := normalizeICalURL("webcal://p01.icloud.com/published/x.ics"); got != "https://p01.icloud.com/published/x.ics" {
		t.Errorf("webcal not upgraded: %q", got)
	}
	if got := normalizeICalURL("  https://x/cal.ics  "); got != "https://x/cal.ics" {
		t.Errorf("trim/passthrough failed: %q", got)
	}
}

func TestParseICal(t *testing.T) {
	ics := "BEGIN:VCALENDAR\r\n" +
		"BEGIN:VEVENT\r\n" +
		"SUMMARY:Dentist\r\n" +
		"LOCATION:Downtown\r\n" +
		"DTSTART:20260801T190000Z\r\n" +
		"DTEND:20260801T200000Z\r\n" +
		"END:VEVENT\r\n" +
		"BEGIN:VEVENT\r\n" +
		"SUMMARY:All day picnic\r\n" +
		"DTSTART;VALUE=DATE:20260802\r\n" +
		"END:VEVENT\r\n" +
		"BEGIN:VEVENT\r\n" + // out of window — should be filtered
		"SUMMARY:Too far\r\n" +
		"DTSTART:20270101T120000Z\r\n" +
		"END:VEVENT\r\n" +
		"END:VCALENDAR\r\n"
	from, _ := time.Parse(time.RFC3339, "2026-07-01T00:00:00Z")
	to, _ := time.Parse(time.RFC3339, "2026-09-01T00:00:00Z")
	evs, err := parseICal(strings.NewReader(ics), from, to)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("want 2 in-window events, got %d: %+v", len(evs), evs)
	}
	if evs[0].Title != "Dentist" || evs[0].Location != "Downtown" {
		t.Errorf("first event wrong: %+v", evs[0])
	}
	if !evs[1].AllDay {
		t.Errorf("second event should be all-day: %+v", evs[1])
	}
}

func TestStubImportedEventsFilters(t *testing.T) {
	only := []db.CalendarConnection{{Provider: "google"}}
	evs := stubImportedEvents(only)
	if len(evs) == 0 {
		t.Fatal("expected google stub events")
	}
	for _, e := range evs {
		if e.Provider != "google" {
			t.Errorf("unconnected provider leaked: %s", e.Provider)
		}
	}
	if len(stubImportedEvents(nil)) != 0 {
		t.Error("no connections should yield no events")
	}
}

func testEvent(t *testing.T) db.Event {
	t.Helper()
	id, ok := parseUUID("11111111-2222-3333-4444-555555555555")
	if !ok {
		t.Fatal("seed uuid should parse")
	}
	start, _ := parseTS("2026-07-15T19:00:00Z")
	return db.Event{
		ID:              id,
		HostID:          "host-1",
		Title:           "Dinner; with friends",
		Description:     "Bring a bottle\nof wine",
		LocationMode:    "host_place",
		LocationAddress: "12 Main St",
		SchedulingMode:  "fixed",
		StartsAt:        start,
		Status:          "scheduled",
	}
}

func TestBuildICS(t *testing.T) {
	ev := testEvent(t)
	now := time.Date(2026, 6, 27, 12, 0, 0, 0, time.UTC)
	got := buildICS(ev, now, "https://whensdays.app/e/11111111-2222-3333-4444-555555555555")

	wants := []string{
		"BEGIN:VCALENDAR\r\n",
		"VERSION:2.0\r\n",
		"BEGIN:VEVENT\r\n",
		"UID:11111111-2222-3333-4444-555555555555@whensdays\r\n",
		"DTSTAMP:20260627T120000Z\r\n",
		"DTSTART:20260715T190000Z\r\n",
		"DTEND:20260715T210000Z\r\n",         // +2h default duration
		"SUMMARY:Dinner\\; with friends\r\n", // semicolon escaped
		"DESCRIPTION:Bring a bottle\\nof wine\\n\\nRSVP & details: https://whensdays.app/e/11111111-2222-3333-4444-555555555555\r\n",
		"URL:https://whensdays.app/e/11111111-2222-3333-4444-555555555555\r\n",
		"LOCATION:12 Main St\r\n",
		"END:VEVENT\r\n",
		"END:VCALENDAR\r\n",
	}
	for _, w := range wants {
		if !strings.Contains(got, w) {
			t.Errorf("ics missing %q\n--- full ---\n%s", w, got)
		}
	}
}

func TestBuildICSLocationModes(t *testing.T) {
	ev := testEvent(t)
	ev.LocationMode = "find_venue"
	ev.LocationAddress = ""
	if !strings.Contains(buildICS(ev, time.Now(), ""), "LOCATION:Venue to be decided\r\n") {
		t.Error("find_venue should render a placeholder location")
	}

	ev.LocationMode = "host_place"
	ev.LocationAddress = ""
	if !strings.Contains(buildICS(ev, time.Now(), ""), "LOCATION:Address to come\r\n") {
		t.Error("empty host_place address should render a placeholder")
	}
}

func TestICSEscape(t *testing.T) {
	tests := map[string]string{
		"a,b":      "a\\,b",
		"a;b":      "a\\;b",
		"a\\b":     "a\\\\b",
		"line1\nl": "line1\\nl",
	}
	for in, want := range tests {
		if got := icsEscape(in); got != want {
			t.Errorf("icsEscape(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestICSFilename(t *testing.T) {
	tests := map[string]string{
		"Dinner; with friends": "dinner-with-friends.ics",
		"  Movie Night!  ":     "movie-night.ics",
		"???":                  "event.ics",
	}
	for in, want := range tests {
		if got := icsFilename(in); got != want {
			t.Errorf("icsFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEmptyDescriptionOmitted(t *testing.T) {
	ev := testEvent(t)
	ev.Description = ""
	if strings.Contains(buildICS(ev, time.Now(), ""), "DESCRIPTION:") {
		t.Error("empty description with no link should be omitted entirely")
	}
	// With a link, DESCRIPTION carries the way back to the event.
	if !strings.Contains(buildICS(ev, time.Now(), "https://x/e/1"), "DESCRIPTION:RSVP & details: https://x/e/1\r\n") {
		t.Error("link should synthesize a DESCRIPTION")
	}
}
