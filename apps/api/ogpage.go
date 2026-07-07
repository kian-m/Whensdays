package main

import (
	"fmt"
	"html"
	"net/http"
)

// ogpage.go — link unfurls. Chat apps (iMessage/WhatsApp/Discord/Slack) fetch
// invite links with no JS, so the SPA's meta tags never reach them. nginx
// proxies full-page loads of /e/{id} here; we return a tiny HTML shell whose
// Open Graph tags describe the event, then bounce real browsers to the SPA at
// /ev/{id}. Exposing title/time/type to anyone holding the link matches the
// existing capability model (the link IS the invite).
func (s *server) handleOGPage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUID(r.PathValue("id"))
	title, desc := "Whensdays", "Plans, minus the group-chat chaos."
	if ok {
		if ev, err := s.queries.GetEvent(r.Context(), id); err == nil {
			title = ev.Title + " · Whensdays"
			switch {
			case ev.Status == "cancelled":
				desc = "This get-together was cancelled."
			case ev.StartsAt.Valid:
				desc = "You're invited — " + ev.StartsAt.Time.In(eventLocation(ev)).Format("Mon Jan 2, 3:04 PM MST") + ". Tap to RSVP, no account needed."
			default:
				desc = "You're invited — help pick the time. Tap to vote, no account needed."
			}
		}
	}
	target := "/ev/" + r.PathValue("id")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery // preserve ?guest=1 etc. through the bounce
	}
	base := s.ogBaseURL(r)
	// Per-event social card: cover/gif + host name + logo (ogimage.go).
	image := base + "/api/events/" + r.PathValue("id") + "/og.png"
	pageURL := base + "/e/" + r.PathValue("id")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// This is the one HTML endpoint on an otherwise JSON/image API; the global
	// default-src 'none' CSP would block an inline bounce script, so we redirect
	// browsers with a script-free <meta refresh> (scrapers ignore it and read
	// the OG tags above). No CSP exception needed.
	fmt.Fprintf(w, `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>%[1]s</title>
<meta property="og:title" content="%[1]s">
<meta property="og:description" content="%[2]s">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Whensdays">
<meta property="og:url" content="%[4]s">
<meta property="og:image" content="%[5]s">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="%[1]s">
<meta name="twitter:description" content="%[2]s">
<meta name="twitter:image" content="%[5]s">
<meta name="description" content="%[2]s">
<meta http-equiv="refresh" content="0; url=%[3]s">
</head><body>
<p><a href="%[3]s">Open the invite</a></p>
</body></html>`, html.EscapeString(title), html.EscapeString(desc), html.EscapeString(target),
		html.EscapeString(pageURL), html.EscapeString(image))
}

// ogBaseURL is the absolute site origin for OG tags: APP_ORIGIN in prod, else
// derived from the request (X-Forwarded-Proto behind the proxy, else http).
func (s *server) ogBaseURL(r *http.Request) string {
	if s.appOrigin != "" {
		return s.appOrigin
	}
	scheme := "http"
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	} else if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
