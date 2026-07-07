package main

import (
	"strings"
	"testing"

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
