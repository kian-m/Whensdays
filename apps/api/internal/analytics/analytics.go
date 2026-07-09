// Package analytics is a thin, dependency-isolated wrapper around PostHog for the
// API. It is always safe to call: when no POSTHOG_API_KEY is configured (local
// dev, hermetic E2E/CI) every method is a no-op, so handlers never need to guard.
//
// Distinct IDs are the authenticated user id (the Clerk sub, or "demo-user" in
// dev) - the SAME id the frontend uses - so server- and client-side events stitch
// to one person in PostHog.
package analytics

import (
	"log/slog"

	"github.com/posthog/posthog-go"
)

const anonymousID = "anonymous"

// Config is read from the environment in main.
type Config struct {
	APIKey         string // project API key (phc_...) - also shipped to the browser; not a hard secret
	Host           string // e.g. https://us.i.posthog.com
	PersonalAPIKey string // phx_... - SECRET; enables local feature-flag evaluation
	Env            string // APP_ENV (development|production)
	Release        string // optional build/commit, attached to every event
}

// Client wraps the PostHog client. A zero/disabled Client (ph == nil) no-ops.
type Client struct {
	ph      posthog.Client
	env     string
	release string
	logger  *slog.Logger
}

// New builds a Client. With no API key it returns a disabled (no-op) Client.
func New(cfg Config, logger *slog.Logger) *Client {
	c := &Client{env: cfg.Env, release: cfg.Release, logger: logger}
	if cfg.APIKey == "" {
		logger.Info("analytics disabled (no POSTHOG_API_KEY)")
		return c
	}
	ph, err := posthog.NewWithConfig(cfg.APIKey, posthog.Config{
		Endpoint:       cfg.Host,
		PersonalApiKey: cfg.PersonalAPIKey, // omit and flags fall back to remote eval
	})
	if err != nil {
		logger.Error("analytics init failed; continuing disabled", "err", err)
		return c
	}
	c.ph = ph
	logger.Info("analytics enabled", "host", cfg.Host, "flags_local_eval", cfg.PersonalAPIKey != "")
	return c
}

func (c *Client) Enabled() bool { return c.ph != nil }

func (c *Client) baseProps(extra map[string]any) posthog.Properties {
	p := posthog.NewProperties().Set("service", "api").Set("environment", c.env)
	if c.release != "" {
		p.Set("release", c.release)
	}
	for k, v := range extra {
		p.Set(k, v)
	}
	return p
}

// Capture records a business event tied to a user (creates/updates their person).
func (c *Client) Capture(distinctID, event string, props map[string]any) {
	if c.ph == nil || distinctID == "" {
		return
	}
	if err := c.ph.Enqueue(posthog.Capture{
		DistinctId: distinctID,
		Event:      event,
		Properties: c.baseProps(props),
	}); err != nil {
		c.logger.Warn("analytics capture failed", "event", event, "err", err)
	}
}

// CaptureServer records an operational event NOT tied to a person (e.g. request
// telemetry). It sets $process_person_profile=false so it never bloats person
// data - ideal for metrics/alerts on latency and error rates.
func (c *Client) CaptureServer(event string, props map[string]any) {
	if c.ph == nil {
		return
	}
	p := c.baseProps(props).Set("$process_person_profile", false)
	if err := c.ph.Enqueue(posthog.Capture{
		DistinctId: anonymousID,
		Event:      event,
		Properties: p,
	}); err != nil {
		c.logger.Warn("analytics server capture failed", "event", event, "err", err)
	}
}

// Identify attaches person properties to a user.
func (c *Client) Identify(distinctID string, props map[string]any) {
	if c.ph == nil || distinctID == "" {
		return
	}
	if err := c.ph.Enqueue(posthog.Identify{
		DistinctId: distinctID,
		Properties: c.baseProps(props),
	}); err != nil {
		c.logger.Warn("analytics identify failed", "err", err)
	}
}

// IsFeatureEnabled evaluates a boolean feature flag for a user. Returns false on
// any error or when analytics is disabled (fail-closed).
func (c *Client) IsFeatureEnabled(distinctID, flag string) bool {
	if c.ph == nil || distinctID == "" {
		return false
	}
	res, err := c.ph.IsFeatureEnabled(posthog.FeatureFlagPayload{Key: flag, DistinctId: distinctID})
	if err != nil {
		c.logger.Warn("feature flag eval failed", "flag", flag, "err", err)
		return false
	}
	enabled, _ := res.(bool)
	return enabled
}

// AllFlags returns every evaluated flag for a user (empty map when disabled).
func (c *Client) AllFlags(distinctID string) map[string]any {
	out := map[string]any{}
	if c.ph == nil || distinctID == "" {
		return out
	}
	flags, err := c.ph.GetAllFlags(posthog.FeatureFlagPayloadNoKey{DistinctId: distinctID})
	if err != nil {
		c.logger.Warn("get all flags failed", "err", err)
		return out
	}
	for k, v := range flags {
		out[k] = v
	}
	return out
}

// Close flushes any buffered events. Call on shutdown.
func (c *Client) Close() {
	if c.ph != nil {
		_ = c.ph.Close()
	}
}
