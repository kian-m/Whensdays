package main

import (
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/clsandbox/api/internal/db"
)

func pubEvent(id byte, host, topic, etype string, daysOut float64, now time.Time) db.ListPublicEventsRow {
	var b [16]byte
	b[0] = id
	return db.ListPublicEventsRow{
		ID: pgtype.UUID{Bytes: b, Valid: true}, HostID: host, Topic: topic, EventType: etype,
		StartsAt: pgtype.Timestamptz{Time: now.Add(time.Duration(daysOut * 24 * float64(time.Hour))), Valid: true},
	}
}

func emptySignals(now time.Time) feedSignals {
	return feedSignals{
		FollowedHosts: map[string]bool{}, FollowedTopics: map[string]bool{},
		HostPrior: map[string]int{}, TopicPrior: map[string]int{}, TypePrior: map[string]int{},
		FriendGoing: map[string]int{}, Going: map[string]int{}, Now: now,
	}
}

func TestScoreSignals(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	base := pubEvent(1, "h1", "gaming", "other", 4, now) // sweet-spot timing

	sig := emptySignals(now)
	cold := score(base, sig)
	if cold != 15 { // pure time proximity
		t.Fatalf("cold score = %v, want 15", cold)
	}

	sig.FollowedHosts["h1"] = true
	if got := score(base, sig); got != cold+wFollowHost {
		t.Errorf("followed host: %v", got)
	}
	sig = emptySignals(now)
	sig.FollowedTopics["gaming"] = true
	if got := score(base, sig); got != cold+wFollowTopic {
		t.Errorf("followed topic: %v", got)
	}
	// Caps hold: 100 prior events with a host don't dominate everything.
	sig = emptySignals(now)
	sig.HostPrior["h1"] = 100
	if got := score(base, sig); got != cold+40 {
		t.Errorf("host prior should cap at 40: %v", got)
	}
	// Social proof.
	sig = emptySignals(now)
	sig.FriendGoing[uuidStr(base.ID)] = 2
	if got := score(base, sig); got != cold+2*wFriendGoing {
		t.Errorf("friends going: %v", got)
	}
}

func TestRankOrdering(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	followed := pubEvent(1, "fav", "books", "other", 20, now) // far out but followed
	near := pubEvent(2, "x", "", "dinner", 4, now)            // ideal timing, no signals
	distant := pubEvent(3, "y", "", "dinner", 45, now)        // far, no signals
	sig := emptySignals(now)
	sig.FollowedHosts["fav"] = true

	ranked := rankEvents([]db.ListPublicEventsRow{distant, near, followed}, sig)
	if ranked[0].HostID != "fav" {
		t.Errorf("followed host should rank first, got %s", ranked[0].HostID)
	}
	if ranked[1].HostID != "x" || ranked[2].HostID != "y" {
		t.Errorf("time proximity should break the tie: %s, %s", ranked[1].HostID, ranked[2].HostID)
	}
}

func TestTimeProximityShape(t *testing.T) {
	now := time.Now()
	if timeProximity(now, now.Add(-time.Hour)) != 0 {
		t.Error("past events score 0")
	}
	if timeProximity(now, now.Add(4*24*time.Hour)) <= timeProximity(now, now.Add(40*24*time.Hour)) {
		t.Error("sweet spot should beat far future")
	}
}

func TestExpandCityFilter(t *testing.T) {
	if got := expandCityFilter(""); len(got) != 0 {
		t.Errorf("empty → no patterns, got %v", got)
	}
	if got := expandCityFilter("Portland"); len(got) != 1 || got[0] != "%Portland%" {
		t.Errorf("plain city: %v", got)
	}
	got := expandCityFilter("bay area, ca") // case-insensitive region match
	if len(got) < 5 {
		t.Fatalf("region should expand to members: %v", got)
	}
	joined := strings.Join(got, "|")
	if !strings.Contains(joined, "%Oakland%") || !strings.Contains(joined, "%Bay Area, CA%") {
		t.Errorf("expansion missing members/region: %v", got)
	}
}

func TestValidCategory(t *testing.T) {
	if !validCategory("gaming") || validCategory("twitch") || validCategory("") {
		t.Error("category validation wrong")
	}
}
