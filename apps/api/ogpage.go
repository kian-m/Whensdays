package main

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
)

// ogpage.go - link unfurls. Chat apps (iMessage/WhatsApp/Discord/Slack) fetch
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
			// Live social pressure in the chat preview: "4 in so far". One
			// going is just the host - only worth surfacing from two up.
			social := ""
			if going, cerr := s.queries.CountGoing(r.Context(), id); cerr == nil && going >= 2 && ev.Status != "cancelled" {
				social = fmt.Sprintf(" %d in so far.", going)
			}
			switch {
			case ev.Status == "cancelled":
				desc = "This get-together was cancelled."
			case ev.StartsAt.Valid:
				desc = "You're invited - " + ev.StartsAt.Time.In(eventLocation(ev)).Format("Mon Jan 2, 3:04 PM MST") + "." + social + " Tap to RSVP, no account needed."
			default:
				desc = "You're invited - help pick the time." + social + " Tap to vote, no account needed."
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
	writeOGHTML(w, title, desc, target, pageURL, image)
}

// handleGroupOGPage is the group-invite twin of handleOGPage: nginx proxies
// full-page loads of /g/{id} here so chat apps get a real preview (group name,
// "<who> invited you to join", the group's icon/gif), then browsers bounce to
// the SPA at /gv/{id}. The group id is the invite capability, same as events.
func (s *server) handleGroupOGPage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUID(r.PathValue("id"))
	title, desc := "Whensdays", "Plans, minus the group-chat chaos."
	from := r.URL.Query().Get("from")
	if ok {
		if g, err := s.queries.GetGroup(r.Context(), id); err == nil {
			title = g.Name + " · Whensdays"
			if inviter := s.groupInviterName(r.Context(), id, from); inviter != "" {
				desc = inviter + " invited you to join " + g.Name + " on Whensdays. Tap to join, no account needed."
			} else {
				desc = "You're invited to join " + g.Name + " on Whensdays. Tap to join, no account needed."
			}
		}
	}
	target := "/gv/" + r.PathValue("id")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery // preserve ?from=… through the bounce
	}
	base := s.ogBaseURL(r)
	image := base + "/api/groups/" + r.PathValue("id") + "/og.png"
	if from != "" {
		image += "?from=" + url.QueryEscape(from)
	}
	pageURL := base + "/g/" + r.PathValue("id")
	writeOGHTML(w, title, desc, target, pageURL, image)
}

// writeOGHTML renders the tiny unfurl shell: Open Graph tags for scrapers plus a
// script-free <meta refresh> that bounces real browsers to the SPA (the global
// default-src 'none' CSP would block an inline script). All fields are escaped.
func writeOGHTML(w http.ResponseWriter, title, desc, target, pageURL, image string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
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
