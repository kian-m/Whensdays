package main

import (
	"math"
	"sort"
	"time"

	"github.com/clsandbox/api/internal/db"
)

// ranking.go — the "For you" feed. Social-media-style pipeline, deliberately
// simple and inspectable:
//
//	candidates (upcoming public events)
//	  → feature extraction (explicit follows, RSVP-history affinities,
//	    friends-going social proof, popularity, time proximity)
//	  → weighted linear score  → rank.
//
// All weights live here so tuning is a one-file change. score() is pure for
// table-driven tests. No engagement-bait terms: nothing rewards outrage or
// session time — just relevance and social proof.

// categories are the ONLY topics a new public event may use (server-enforced;
// the web shows them as chips). Curated for IRL + online communities.
var categories = []string{
	"gaming", "streams", "sports", "tabletop", "books", "music",
	"food-drink", "outdoors", "arts", "tech", "wellness", "social", "other",
}

func validCategory(t string) bool { return oneOf(t, categories...) }

// feedSignals is everything we know about the viewer, pre-aggregated.
type feedSignals struct {
	FollowedHosts  map[string]bool // host ids the user follows
	FollowedTopics map[string]bool // topics the user follows
	HostPrior      map[string]int  // host id → # past going/maybe RSVPs with them
	TopicPrior     map[string]int  // topic → # past going/maybe RSVPs
	TypePrior      map[string]int  // event_type → # past going/maybe RSVPs
	FriendGoing    map[string]int  // event id → # friends going (social proof)
	Going          map[string]int  // event id → total going (popularity)
	Now            time.Time
}

// Weights. Explicit intent (follows) > social proof > inferred taste > buzz.
const (
	wFollowHost  = 50.0
	wFollowTopic = 30.0
	wHostPrior   = 20.0 // per prior event with this host, capped
	wTopicPrior  = 8.0  // per prior event in this topic, capped
	wTypePrior   = 4.0  // per prior event of this type, capped
	wFriendGoing = 12.0 // per friend going, capped
	wPopularity  = 2.0  // × log2(1+going), naturally dampened
)

func capped(n int, per float64, cap_ float64) float64 {
	return math.Min(float64(n)*per, cap_)
}

// timeProximity peaks for events a few days out — near enough to plan for,
// far enough to still join — and tapers both ways.
func timeProximity(now, starts time.Time) float64 {
	d := starts.Sub(now).Hours() / 24
	switch {
	case d < 0:
		return 0
	case d < 1:
		return 4 // last-minute: joinable but cramped
	case d < 2:
		return 10
	case d < 7:
		return 15 // the sweet spot
	case d < 14:
		return 10
	case d < 30:
		return 5
	default:
		return 2
	}
}

// score is the whole algorithm. Pure: same inputs, same output.
func score(ev db.ListPublicEventsRow, sig feedSignals) float64 {
	id := uuidStr(ev.ID)
	// Polls have no time yet — give them the mid proximity score (they're the
	// events that most want joiners right now).
	s := 10.0
	if ev.StartsAt.Valid {
		s = timeProximity(sig.Now, ev.StartsAt.Time)
	}
	if sig.FollowedHosts[ev.HostID] {
		s += wFollowHost
	}
	if ev.Topic != "" && sig.FollowedTopics[ev.Topic] {
		s += wFollowTopic
	}
	s += capped(sig.HostPrior[ev.HostID], wHostPrior, 40)
	if ev.Topic != "" {
		s += capped(sig.TopicPrior[ev.Topic], wTopicPrior, 24)
	}
	s += capped(sig.TypePrior[ev.EventType], wTypePrior, 12)
	s += capped(sig.FriendGoing[id], wFriendGoing, 36)
	s += wPopularity * math.Log2(1+float64(sig.Going[id]))
	return s
}

// rankEvents scores and sorts candidates best-first (stable on ties by time).
func rankEvents(events []db.ListPublicEventsRow, sig feedSignals) []db.ListPublicEventsRow {
	type scored struct {
		ev db.ListPublicEventsRow
		s  float64
	}
	xs := make([]scored, len(events))
	for i, e := range events {
		xs[i] = scored{e, score(e, sig)}
	}
	sort.SliceStable(xs, func(i, j int) bool {
		if xs[i].s != xs[j].s {
			return xs[i].s > xs[j].s
		}
		return xs[i].ev.StartsAt.Time.Before(xs[j].ev.StartsAt.Time)
	})
	out := make([]db.ListPublicEventsRow, len(xs))
	for i, x := range xs {
		out[i] = x.ev
	}
	return out
}
