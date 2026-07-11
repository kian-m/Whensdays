package main

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// alerts.go - owner alerting on server errors. Every internal 500 (event
// creation, profile creation, everything else) fires an email to the owner -
// throttled PER TOPIC so an outage reads as one alert with a count, never a
// storm: the first failure of a topic alerts immediately; repeats within the
// window are counted and included when the window reopens. External downtime
// (when the app can't email at all) is covered separately by the GCP uptime
// checks - these two layers are each other's backstop.

const alertWindow = 15 * time.Minute

type alerter struct {
	mu         sync.Mutex
	lastSent   map[string]time.Time
	suppressed map[string]int
}

func newAlerter() *alerter {
	return &alerter{lastSent: map[string]time.Time{}, suppressed: map[string]int{}}
}

// shouldSend reports whether a topic may alert now, returning how many
// occurrences were suppressed since the last send.
func (a *alerter) shouldSend(topic string, now time.Time) (bool, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if last, ok := a.lastSent[topic]; ok && now.Sub(last) < alertWindow {
		a.suppressed[topic]++
		return false, 0
	}
	n := a.suppressed[topic]
	a.suppressed[topic] = 0
	a.lastSent[topic] = now
	return true, n
}

// alert emails the owner about a server error. Best-effort and async via the
// notify client; no-ops when email or the recipient is unconfigured (dev/E2E).
func (s *server) alert(topic string, err error) {
	to := os.Getenv("ALERT_EMAIL")
	if to == "" {
		to = os.Getenv("ANALYTICS_DIGEST_TO")
	}
	if to == "" || !s.notify.Enabled() {
		return
	}
	ok, suppressed := s.alerts.shouldSend(topic, time.Now())
	if !ok {
		return
	}
	detail := fmt.Sprintf("Error: %v", err)
	if suppressed > 0 {
		detail += fmt.Sprintf("\n\nAlso: %d earlier occurrence(s) of this topic were suppressed in the last %s.", suppressed, alertWindow)
	}
	body := renderEmail(emailContent{
		preheader: "A server error needs eyes.",
		heading:   "⚠️ " + topic,
		lines: []string{
			detail,
			time.Now().UTC().Format("2006-01-02 15:04:05 UTC"),
			"Further '" + topic + "' failures are muted for 15 minutes and will be counted.",
		},
		ctaLabel: "Open Cloud Run logs",
		ctaURL:   "https://console.cloud.google.com/run/detail/us-central1/whensdays-api/logs?project=whensdays",
		logoURL:  s.logoURL(),
		theme:    "analytics",
	})
	s.notify.Send([]string{to}, "⚠️ Whensdays: "+topic, body)
}
