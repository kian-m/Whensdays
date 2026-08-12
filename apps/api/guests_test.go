package main

import (
	"time"
	"strings"
	"testing"

	"github.com/clsandbox/api/internal/db"
	"github.com/clsandbox/api/internal/notify"
)

func TestGuestTokenRoundTrip(t *testing.T) {
	g := guestSigner{key: []byte("test-key")}
	tok := g.sign("guest_abc123")
	uid, ok := g.verify(tok)
	if !ok || uid != "guest_abc123" {
		t.Fatalf("verify = %q,%v", uid, ok)
	}
	if _, ok := g.verify(tok + "x"); ok {
		t.Fatal("tampered token verified")
	}
	if _, ok := (guestSigner{key: []byte("other")}).verify(tok); ok {
		t.Fatal("wrong-key token verified")
	}
	// Non-guest ids must not be signable into valid guest identities.
	forged := g.sign("user_2abc") // sign only ever gets guest_ ids, but verify must enforce it
	if _, ok := g.verify(forged); ok {
		t.Fatal("non-guest id accepted")
	}
}

func TestHMACEnvelope(t *testing.T) {
	key := []byte("envelope-key")
	tok := hmacSeal(key, "hello|world")
	got, ok := hmacOpen(key, tok)
	if !ok || string(got) != "hello|world" {
		t.Fatalf("hmacOpen = %q,%v", got, ok)
	}
	// Tamper, wrong key, and malformed tokens all fail closed.
	if _, ok := hmacOpen(key, tok+"x"); ok {
		t.Fatal("tampered signature verified")
	}
	if _, ok := hmacOpen([]byte("other-key"), tok); ok {
		t.Fatal("wrong key verified")
	}
	if _, ok := hmacOpen(key, "no-dot-here"); ok {
		t.Fatal("malformed token verified")
	}
}

func TestMuteTokenRoundTrip(t *testing.T) {
	g := guestSigner{key: []byte("test-key")}
	tok := g.signMute("user_2abc", "evt-123")
	uid, evt, ok := g.verifyMute(tok)
	if !ok || uid != "user_2abc" || evt != "evt-123" {
		t.Fatalf("verifyMute = %q,%q,%v", uid, evt, ok)
	}
	if _, _, ok := g.verifyMute(tok + "x"); ok {
		t.Fatal("tampered mute token verified")
	}
	if _, _, ok := (guestSigner{key: []byte("other")}).verifyMute(tok); ok {
		t.Fatal("wrong-key mute token verified")
	}
	// A guest bearer token must NOT validate as a mute token (namespace isolation).
	if _, _, ok := g.verifyMute(g.sign("guest_abc")); ok {
		t.Fatal("guest token accepted as mute token")
	}
}

func TestRsvpTokenRoundTrip(t *testing.T) {
	g := guestSigner{key: []byte("test-key")}
	tok := g.signRsvp("user_2abc", "evt-123")
	uid, evt, ok := g.verifyRsvp(tok)
	if !ok || uid != "user_2abc" || evt != "evt-123" {
		t.Fatalf("verifyRsvp = %q,%q,%v", uid, evt, ok)
	}
	// Namespace isolation: mute/guest tokens must not validate as RSVP tokens.
	if _, _, ok := g.verifyRsvp(g.signMute("user_2abc", "evt-123")); ok {
		t.Fatal("mute token accepted as rsvp token")
	}
	if _, _, ok := g.verifyRsvp(g.sign("guest_abc")); ok {
		t.Fatal("guest token accepted as rsvp token")
	}
}

func TestFollowTokenRoundTrip(t *testing.T) {
	g := guestSigner{key: []byte("test-key")}
	tok := g.signFollow("user_2abc", "group", "11111111-2222-3333-4444-555555555555")
	uid, kind, value, ok := g.verifyFollow(tok)
	if !ok || uid != "user_2abc" || kind != "group" || value != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("verifyFollow = %q,%q,%q,%v", uid, kind, value, ok)
	}
	if _, _, _, ok := g.verifyFollow(tok + "x"); ok {
		t.Fatal("tampered follow token verified")
	}
	if _, _, _, ok := (guestSigner{key: []byte("other")}).verifyFollow(tok); ok {
		t.Fatal("wrong-key follow token verified")
	}
	// Namespace isolation: no other capability's token should validate here,
	// and a follow token should not validate as any other capability.
	if _, _, _, ok := g.verifyFollow(g.signMute("user_2abc", "evt-123")); ok {
		t.Fatal("mute token accepted as follow token")
	}
	if _, _, _, ok := g.verifyFollow(g.sign("guest_abc")); ok {
		t.Fatal("guest token accepted as follow token")
	}
	if _, _, ok := g.verifyMute(tok); ok {
		t.Error("follow token accepted as a mute token")
	}
	if _, _, ok := g.verifyRsvp(tok); ok {
		t.Error("follow token accepted as an rsvp token")
	}
	// Host-kind follow round-trips too (value = a Clerk user id, not a UUID).
	tok2 := g.signFollow("user_2abc", "host", "user_9xyz")
	if _, kind2, value2, ok := g.verifyFollow(tok2); !ok || kind2 != "host" || value2 != "user_9xyz" {
		t.Fatalf("verifyFollow (host) = %q,%q,%v", kind2, value2, ok)
	}
}

func TestNotifyPayload(t *testing.T) {
	p := notify.Payload("a@x.com", []string{"b@y.com"}, "Sub", "<b>hi</b>")
	if p["from"] != "a@x.com" || p["subject"] != "Sub" {
		t.Fatalf("payload wrong: %+v", p)
	}
	if to, ok := p["to"].([]string); !ok || to[0] != "b@y.com" {
		t.Fatalf("to wrong: %+v", p["to"])
	}
}

func TestValidEmoji(t *testing.T) {
	good := []string{"🎉", "👨‍👩‍👧‍👦", "🏃‍♀️"}
	bad := []string{"", "abc", "a🎉", "🎉 🎉", "123", "<script>", "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉"}
	for _, s := range good {
		if !validEmoji(s) {
			t.Errorf("validEmoji(%q) should pass", s)
		}
	}
	for _, s := range bad {
		if validEmoji(s) {
			t.Errorf("validEmoji(%q) should fail", s)
		}
	}
}

func TestShiftOccurrence(t *testing.T) {
	base, _ := parseTS("2026-07-06T19:00:00Z")
	if got := shiftOccurrence(base, "weekly", 2).Time.Format("2006-01-02"); got != "2026-07-20" {
		t.Errorf("weekly+2 = %s", got)
	}
	if got := shiftOccurrence(base, "biweekly", 1).Time.Format("2006-01-02"); got != "2026-07-20" {
		t.Errorf("biweekly+1 = %s", got)
	}
	if got := shiftOccurrence(base, "monthly", 3).Time.Format("2006-01-02"); got != "2026-10-06" {
		t.Errorf("monthly+3 = %s", got)
	}
}

func TestTopicValidation(t *testing.T) {
	if err := validatePublicFields("public", "tabletop", "Portland"); err != nil {
		t.Errorf("valid public fields rejected: %v", err)
	}
	for _, bad := range [][3]string{
		{"everyone", "", ""},                    // bad visibility
		{"public", "board-games", ""},           // not a preset category
		{"public", "Gaming", ""},                // wrong case
		{"public", "", strings.Repeat("x", 61)}, // long city
	} {
		if err := validatePublicFields(bad[0], bad[1], bad[2]); err == nil {
			t.Errorf("validatePublicFields(%v) should fail", bad)
		}
	}
}

func TestEmailBodyEscapes(t *testing.T) {
	b := renderEmail(emailContent{
		heading: "<script>",
		lines:   []string{"a & b"},
		quote:   "x\"><img src=y>",
		ctaURL:  "https://x/e/1", ctaLabel: "Open",
	})
	if !strings.Contains(b, "&lt;script&gt;") {
		t.Fatalf("heading not escaped: %s", b)
	}
	if !strings.Contains(b, "a &amp; b") {
		t.Fatalf("body not escaped: %s", b)
	}
	if strings.Contains(b, "<img src=y>") {
		t.Fatalf("quote not escaped: %s", b)
	}
}

func TestCampaignURL(t *testing.T) {
	got := campaignURL("https://w.app/e/abc", "finalized")
	want := "https://w.app/e/abc?utm_source=whensdays&utm_medium=email&utm_campaign=email_finalized"
	if got != want {
		t.Fatalf("campaignURL = %s, want %s", got, want)
	}
	// Preserves an existing query string with & instead of ?.
	if q := campaignURL("https://w.app/e/abc?x=1", "reminder"); !strings.Contains(q, "?x=1&utm_source=") {
		t.Fatalf("existing query not preserved: %s", q)
	}
}

func TestCollapseActivity(t *testing.T) {
	ev1, ev2 := newUUID(), newUUID()
	rows := []db.DrainDueNotificationsRow{
		{RecipientID: "host", EventID: ev1, Kind: "rsvp", ActorID: "u1", ActorName: "Maya"},
		{RecipientID: "host", EventID: ev1, Kind: "comment", ActorID: "u2", ActorName: "Dev", Body: "see you there"},
		{RecipientID: "host", EventID: ev1, Kind: "rsvp", ActorID: "u1", ActorName: "Maya"}, // flip-flop → one line
		{RecipientID: "host", EventID: ev2, Kind: "comment", ActorID: "u3", ActorName: "Sam", Body: ""},
		{RecipientID: "other", EventID: ev2, Kind: "rsvp", ActorID: "u1", ActorName: "Maya"},
	}
	got := collapseActivity(rows)
	if len(got["host"]) != 3 {
		t.Fatalf("host lines = %d, want 3 (rsvp collapsed): %+v", len(got["host"]), got["host"])
	}
	if len(got["other"]) != 1 {
		t.Fatalf("other lines = %d, want 1", len(got["other"]))
	}
	joined := ""
	for _, l := range got["host"] {
		joined += l.text + "\n"
	}
	if !strings.Contains(joined, "Maya is going") || !strings.Contains(joined, "Dev: see you there") || !strings.Contains(joined, "sent a GIF") {
		t.Fatalf("unexpected digest lines: %s", joined)
	}
}

func TestStreakLen(t *testing.T) {
	m := func(ks ...int) map[int]bool {
		out := map[int]bool{}
		for _, k := range ks {
			out[k] = true
		}
		return out
	}
	cases := []struct {
		name   string
		months map[int]bool
		cur    int
		want   int
	}{
		{"empty", m(), 100, 0},
		{"current only", m(100), 100, 1},
		{"three consecutive", m(98, 99, 100), 100, 3},
		{"gap breaks the run", m(97, 99, 100), 100, 2},
		{"current month missing = no streak ending now", m(98, 99), 100, 0},
		{"future months ignored", m(100, 101, 102), 100, 1},
	}
	for _, c := range cases {
		if got := streakLen(c.months, c.cur); got != c.want {
			t.Errorf("%s: streakLen = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestGroupFollowedEvents(t *testing.T) {
	ev1, ev2, ev3 := newUUID(), newUUID(), newUUID()
	rows := []db.ListNewFollowedEventsRow{
		{RecipientID: "u1", ID: ev1, Title: "Jam night"},
		{RecipientID: "u2", ID: ev2, Title: "Open mic"},
		{RecipientID: "u1", ID: ev3, Title: "Improv 101"}, // u1's second event
	}
	byUser, order := groupFollowedEvents(rows)
	if len(order) != 2 || order[0] != "u1" || order[1] != "u2" {
		t.Fatalf("order = %v, want [u1 u2] (first-seen)", order)
	}
	if len(byUser["u1"]) != 2 {
		t.Fatalf("u1 events = %d, want 2", len(byUser["u1"]))
	}
	if len(byUser["u2"]) != 1 {
		t.Fatalf("u2 events = %d, want 1", len(byUser["u2"]))
	}
	if byUser["u1"][0].Title != "Jam night" || byUser["u1"][1].Title != "Improv 101" {
		t.Fatalf("u1 events out of order: %+v", byUser["u1"])
	}
}

func TestFollowDigestSubject(t *testing.T) {
	one := []db.ListNewFollowedEventsRow{{PageName: "UCB", Title: "Improv Jam"}}
	if got := followDigestSubject(one); got != "UCB: Improv Jam" {
		t.Errorf("single event subject = %q, want %q", got, "UCB: Improv Jam")
	}
	many := []db.ListNewFollowedEventsRow{
		{PageName: "UCB", Title: "Improv Jam"},
		{PageName: "WGIS", Title: "Open Mic"},
	}
	if got := followDigestSubject(many); got != "New from pages you follow" {
		t.Errorf("multi-event subject = %q, want the generic subject", got)
	}
	if got := followDigestSubject(nil); got != "New from pages you follow" {
		t.Errorf("empty subject = %q, want the generic subject", got)
	}
}

func TestFollowKindValue(t *testing.T) {
	gid := newUUID()
	group := db.ListNewFollowedEventsRow{ViaGroup: true, GroupID: gid, HostID: "user_host"}
	if kind, value := followKindValue(group); kind != "group" || value != uuidStr(gid) {
		t.Errorf("group-matched row = %q,%q, want group,%q", kind, value, uuidStr(gid))
	}
	host := db.ListNewFollowedEventsRow{ViaGroup: false, HostID: "user_host"}
	if kind, value := followKindValue(host); kind != "host" || value != "user_host" {
		t.Errorf("host-matched row = %q,%q, want host,user_host", kind, value)
	}
}

func TestAlerterThrottle(t *testing.T) {
	a := newAlerter()
	t0 := time.Now()
	if ok, n := a.shouldSend("create event", t0); !ok || n != 0 {
		t.Fatalf("first alert should send (ok=%v n=%d)", ok, n)
	}
	for i := 0; i < 5; i++ {
		if ok, _ := a.shouldSend("create event", t0.Add(time.Duration(i)*time.Minute)); ok {
			t.Fatal("inside the window must suppress")
		}
	}
	// A different topic is independent.
	if ok, _ := a.shouldSend("upsert profile", t0.Add(time.Minute)); !ok {
		t.Fatal("other topics alert independently")
	}
	// Window reopens carrying the suppressed count.
	ok, n := a.shouldSend("create event", t0.Add(alertWindow+time.Second))
	if !ok || n != 5 {
		t.Fatalf("window reopen: ok=%v suppressed=%d (want 5)", ok, n)
	}
}

func TestSafeImageDataURL(t *testing.T) {
	ok := []string{
		"data:image/png;base64,iVBOR",
		"data:image/jpeg;base64,/9j/4",
		"data:image/gif;base64,R0lGOD",
		"data:image/webp;base64,UklGR",
	}
	bad := []string{
		"data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==", // XSS vector
		"data:image/svg+xml,<svg onload=alert(1)>",
		"data:text/html;base64,PGh0bWw+",
		"javascript:alert(1)",
		"https://evil.example/x.png",
		"data:image/png", // no payload separator
	}
	for _, u := range ok {
		if !safeImageDataURL(u) {
			t.Errorf("should accept raster: %q", u)
		}
	}
	for _, u := range bad {
		if safeImageDataURL(u) {
			t.Errorf("should REJECT: %q", u)
		}
	}
}
