package main

import (
	"fmt"
	"html"
	"strings"
)

// emails.go — the branded HTML for transactional email. Whensdays' look is
// "sunset through glass" (see styles.css): a teal-navy dusk with a coral accent.
// Email clients strip <style>/<link> and external CSS, so everything here is
// inline and table-based (the only layout that survives Outlook/Gmail). Copy is
// warm and short — these are coordination nudges, not marketing.
//
// Every in-email link is UTM-tagged (campaignURL) so PostHog attributes the
// resulting visit to email: it auto-captures utm_* on the landing pageview and
// the web forwards them into the distinct person timeline. One campaign value
// per email type keeps the funnel legible (email_finalized, email_reminder, …).

// brand palette — mirrors the dark-default tokens in styles.css.
const (
	emailBG     = "#10141f" // page dusk
	emailPanel  = "#1a2233" // frosted panel
	emailInk    = "#f4f1ec" // primary text
	emailMuted  = "#9aa4b6" // secondary text
	emailAccent = "#ee6c4d" // coral
	emailAccnt2 = "#d3572f" // coral (deep, for the gradient)
	emailLine   = "#2b3550" // hairline border
)

// campaignURL appends the email UTM triplet so PostHog can attribute the visit.
// campaign is the email type (e.g. "finalized") → utm_campaign=email_finalized.
func campaignURL(base, campaign string) string {
	if base == "" {
		return ""
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return base + sep + "utm_source=whensdays&utm_medium=email&utm_campaign=email_" + campaign
}

// emailMetaRow is a labelled fact shown in the event summary block (When / Where).
type emailMetaRow struct{ label, value string }

// emailContent is the variable payload for one message; renderEmail turns it into
// a full, client-safe HTML document.
type emailContent struct {
	preheader string         // hidden inbox-preview line
	heading   string         // big title inside the card
	lines     []string       // body paragraphs (plain text, escaped here)
	meta      []emailMetaRow // optional When/Where facts
	quote     string         // optional highlighted snippet (e.g. a comment)
	ctaLabel  string         // button text
	ctaURL    string         // button href (already UTM-tagged by the caller)
	logoURL   string         // hosted PNG logo (APP_ORIGIN/apple-touch-icon.png)
}

func esc(s string) string { return html.EscapeString(s) }

// renderEmail composes the branded document. Structure: hidden preheader → dark
// gradient header with the logo + wordmark → frosted content card (heading,
// paragraphs, optional quote, optional meta table, coral CTA) → muted footer.
func renderEmail(c emailContent) string {
	var b strings.Builder

	// Hidden preheader — the grey preview text next to the subject in most inboxes.
	if c.preheader != "" {
		fmt.Fprintf(&b, `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:%s">%s</div>`,
			emailBG, esc(c.preheader))
	}

	// Outer wrapper.
	fmt.Fprintf(&b, `<div style="margin:0;padding:24px 12px;background:%s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:%s">`,
		emailBG, emailInk)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto"><tr><td>`)

	// Header — brand gradient bar with logo + wordmark.
	logo := ""
	if c.logoURL != "" {
		logo = fmt.Sprintf(`<img src="%s" width="34" height="34" alt="" style="vertical-align:middle;border-radius:9px;margin-right:10px">`, esc(c.logoURL))
	}
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:linear-gradient(120deg,%s,%s);border-radius:14px 14px 0 0"><tr><td style="padding:18px 24px">%s<span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#fff;vertical-align:middle">Whensdays</span></td></tr></table>`,
		emailAccent, emailAccnt2, logo)

	// Content card.
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%s;border:1px solid %s;border-top:none;border-radius:0 0 14px 14px"><tr><td style="padding:28px 24px">`,
		emailPanel, emailLine)

	fmt.Fprintf(&b, `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:700;color:%s">%s</h1>`,
		emailInk, esc(c.heading))

	for _, ln := range c.lines {
		fmt.Fprintf(&b, `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:%s">%s</p>`, emailInk, esc(ln))
	}

	if c.quote != "" {
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px"><tr><td style="padding:12px 16px;background:%s;border-left:3px solid %s;border-radius:8px;font-size:15px;line-height:1.5;color:%s">%s</td></tr></table>`,
			emailBG, emailAccent, emailInk, esc(c.quote))
	}

	if len(c.meta) > 0 {
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px">`)
		for _, m := range c.meta {
			fmt.Fprintf(&b, `<tr><td style="padding:6px 0;font-size:13px;color:%s;width:64px;vertical-align:top">%s</td><td style="padding:6px 0;font-size:15px;font-weight:600;color:%s">%s</td></tr>`,
				emailMuted, esc(m.label), emailInk, esc(m.value))
		}
		b.WriteString(`</table>`)
	}

	if c.ctaURL != "" && c.ctaLabel != "" {
		fmt.Fprintf(&b, `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 4px"><tr><td style="border-radius:10px;background:linear-gradient(120deg,%s,%s)"><a href="%s" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;border-radius:10px">%s</a></td></tr></table>`,
			emailAccent, emailAccnt2, esc(c.ctaURL), esc(c.ctaLabel))
	}

	b.WriteString(`</td></tr></table>`)

	// Footer.
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 24px;text-align:center;font-size:12px;line-height:1.5;color:%s">You're receiving this because you're part of this plan on Whensdays.<br>Whensdays — scheduling that actually happens.</td></tr></table>`,
		emailMuted)

	b.WriteString(`</td></tr></table></div>`)
	return b.String()
}
