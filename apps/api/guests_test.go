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
	b := emailBody("<script>", "a & b", "https://x/e/1")
	if !strings.Contains(b, "&lt;script&gt;") {
		t.Fatalf("heading not escaped: %s", b)
	}
	if !strings.Contains(b, "a &amp; b") {
		t.Fatalf("detail not escaped: %s", b)
	}
}
