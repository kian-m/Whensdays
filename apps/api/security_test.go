package main

import (
	"net"
	"testing"
	"time"
)

func TestBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1",
		"169.254.169.254", // cloud metadata
		"0.0.0.0", "100.64.0.1", // CGNAT
		"::1", "fc00::1", "fe80::1",
	}
	for _, s := range blocked {
		if !blockedIP(net.ParseIP(s)) {
			t.Errorf("%s should be blocked", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::"}
	for _, s := range allowed {
		if blockedIP(net.ParseIP(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
	if !blockedIP(nil) {
		t.Error("nil IP must be blocked")
	}
}

func TestIPLimiter(t *testing.T) {
	l := newIPLimiter(60, 3) // 1/sec, burst 3
	now := time.Now()
	// Burst of 3 allowed, 4th denied.
	for i := 0; i < 3; i++ {
		if !l.allow("1.2.3.4", now) {
			t.Fatalf("request %d within burst should pass", i)
		}
	}
	if l.allow("1.2.3.4", now) {
		t.Error("4th request in burst should be denied")
	}
	// A different IP is independent.
	if !l.allow("5.6.7.8", now) {
		t.Error("separate IP should have its own bucket")
	}
	// After 2s, ~2 tokens refill.
	if !l.allow("1.2.3.4", now.Add(2*time.Second)) {
		t.Error("token should refill after time passes")
	}
}
