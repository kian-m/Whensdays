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
				desc = "You're invited — " + ev.StartsAt.Time.Format("Mon Jan 2, 3:04 PM MST") + ". Tap to RSVP, no account needed."
			default:
				desc = "You're invited — help pick the time. Tap to vote, no account needed."
			}
		}
	}
	target := "/ev/" + r.PathValue("id")
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
<meta name="twitter:card" content="summary">
<meta name="description" content="%[2]s">
<script>location.replace(%[3]q + location.search)</script>
</head><body>
<p><a href="%[3]s">Open the invite</a></p>
</body></html>`, html.EscapeString(title), html.EscapeString(desc), target)
}
