package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

// tokens.go — the shared tamper-proof token envelope used by every capability
// that has to travel outside an authenticated request: guest bearer tokens
// (guests.go), one-click event-mute links (mute.go), and OAuth `state`
// (calendars_import.go). Each layers its own payload format + expiry on top; the
// envelope crypto lives here once so the three can't drift apart.

// hmacSeal wraps a payload as base64url(payload) + "." + hex(HMAC-SHA256(key,payload)).
func hmacSeal(key []byte, payload string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(mac.Sum(nil))
}

// hmacOpen reverses hmacSeal: it constant-time-verifies the signature and returns
// the decoded payload. ok is false on any malformation or signature mismatch.
// Callers still parse + validate the payload (fields, expiry) themselves.
func hmacOpen(key []byte, token string) (payload []byte, ok bool) {
	dot := strings.LastIndex(token, ".")
	if dot < 0 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(token[:dot])
	if err != nil {
		return nil, false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(raw)
	if !hmac.Equal([]byte(token[dot+1:]), []byte(hex.EncodeToString(mac.Sum(nil)))) {
		return nil, false
	}
	return raw, true
}
