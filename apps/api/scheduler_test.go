package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidHandle(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"alice", true},
		{"a_b-1", true},
		{"123", true},
		{"Alice", false}, // uppercase rejected (handlers lowercase first)
		{"a b", false},   // space
		{"naïve", false}, // non-ascii
		{"a.b", false},   // dot
	}
	for _, tt := range tests {
		if got := validHandle(tt.in); got != tt.want {
			t.Errorf("validHandle(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestParseTS(t *testing.T) {
	if _, ok := parseTS("2026-07-01T19:00:00Z"); !ok {
		t.Error("valid RFC3339 should parse")
	}
	if _, ok := parseTS("next friday"); ok {
		t.Error("garbage should not parse")
	}
}

func TestParseUUID(t *testing.T) {
	if _, ok := parseUUID("00000000-0000-0000-0000-000000000000"); !ok {
		t.Error("valid uuid should parse")
	}
	if _, ok := parseUUID("not-a-uuid"); ok {
		t.Error("invalid uuid should fail")
	}
}

// withUser builds a request carrying an authenticated user id, as the auth
// middleware would, plus a JSON body.
func withUser(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	return req.WithContext(context.WithValue(req.Context(), userIDKey, "u1"))
}

// These exercise the validation branches that must reject bad input *before* any
// DB access, so they run against a server with no queries wired. The full
// happy-path behavior is covered by the Playwright E2E against a real DB.
func TestHandlerValidationRejectsBadInput(t *testing.T) {
	s := &server{}
	tests := []struct {
		name    string
		handler http.HandlerFunc
		req     *http.Request
		want    int
	}{
		{"profile empty", s.handleUpsertProfile, withUser("PUT", "/api/profile", `{"display_name":"","handle":""}`), http.StatusUnprocessableEntity},
		{"profile bad handle", s.handleUpsertProfile, withUser("PUT", "/api/profile", `{"display_name":"A","handle":"bad handle"}`), http.StatusUnprocessableEntity},
		{"event missing title", s.handleCreateEvent, withUser("POST", "/api/events", `{"title":"","location_mode":"host_place","scheduling_mode":"fixed"}`), http.StatusUnprocessableEntity},
		{"event fixed without time", s.handleCreateEvent, withUser("POST", "/api/events", `{"title":"x","location_mode":"host_place","scheduling_mode":"fixed"}`), http.StatusUnprocessableEntity},
		{"availability bad slot", s.handlePutAvailability, withUser("PUT", "/api/availability", `{"slots":[{"weekday":9,"part_of_day":"morning"}]}`), http.StatusUnprocessableEntity},
		{"bad json", s.handleCreateEvent, withUser("POST", "/api/events", `{`), http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tt.handler(rec, tt.req)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.want, rec.Body.String())
			}
		})
	}
}
