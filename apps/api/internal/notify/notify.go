// Package notify sends transactional email (invite accepted, time locked,
// new comment). Same contract as analytics: no-op when unconfigured, so dev
// and hermetic E2E need nothing. Provider is any Resend-compatible HTTP API.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	apiKey string
	from   string
	url    string
	logger *slog.Logger
	http   *http.Client
}

// New reads config; empty apiKey or from → disabled no-op client. A bare
// address (no display name) is wrapped as "Whensdays <addr>" so inboxes show
// the brand, not the mailbox.
func New(apiKey, from string, logger *slog.Logger) *Client {
	if from != "" && !strings.Contains(from, "<") {
		from = "Whensdays <" + from + ">"
	}
	c := &Client{apiKey: apiKey, from: from, url: "https://api.resend.com/emails",
		logger: logger, http: &http.Client{Timeout: 5 * time.Second}}
	if !c.Enabled() {
		logger.Info("email disabled (no EMAIL_API_KEY/EMAIL_FROM)")
	}
	return c
}

func (c *Client) Enabled() bool { return c.apiKey != "" && c.from != "" }

// Payload builds the provider request body (exported for tests).
func Payload(from string, to []string, subject, html string) map[string]any {
	return map[string]any{"from": from, "to": to, "subject": subject, "html": html}
}

// Send fires one email asynchronously, best-effort: coordination nudges must
// never block or fail a request.
func (c *Client) Send(to []string, subject, html string) {
	if !c.Enabled() || len(to) == 0 {
		return
	}
	go func() {
		body, _ := json.Marshal(Payload(c.from, to, subject, html))
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.http.Do(req)
		if err != nil {
			c.logger.Error("email send", "err", err)
			return
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			c.logger.Error("email send", "status", resp.Status)
		}
	}()
}
