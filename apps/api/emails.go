package main

import (
	"os"
	"fmt"
	"html"
	"strings"
)

// emails.go - the branded HTML for transactional email. Whensdays' look is
// "sunset through glass" (see styles.css): a teal-navy dusk with a coral accent.
// Email clients strip <style>/<link> and external CSS, so everything here is
// inline and table-based (the only layout that survives Outlook/Gmail). Copy is
// warm and short - these are coordination nudges, not marketing.
//
// Every in-email link is UTM-tagged (campaignURL) so PostHog attributes the
// resulting visit to email: it auto-captures utm_* on the landing pageview and
// the web forwards them into the distinct person timeline. One campaign value
// per email type keeps the funnel legible (email_finalized, email_reminder, …).

// brand palette - mirrors the dark-default tokens in styles.css.
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

// emailHero: one giant centered stat (the analytics digest's lead widget).
type emailHero struct{ number, label, sub string }

// emailFunnelStep: a labeled count with a proportional bar; width is % of the
// first step, drop annotates loss vs the previous step ("" on the first).
type emailFunnelStep struct {
	label string
	count int
	width int
	drop  string
	warn  bool // draw the bar in the danger color (tier usage past 80%)
}

// renderBars writes a titled section of labeled proportional bars - the
// digest uses it for the drop-off funnel and the free-tier runway. A step
// with warn=true draws its bar in the danger color.
func renderBars(b *strings.Builder, accent, title string, steps []emailFunnelStep) {
	if len(steps) == 0 {
		return
	}
	if title != "" {
		fmt.Fprintf(b, `<div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:%s;margin:0 0 8px">%s</div>`, emailMuted, esc(title))
	}
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">`)
	for _, f := range steps {
		drop := ""
		if f.drop != "" {
			drop = fmt.Sprintf(` <span style="font-weight:600;color:%s;font-size:12px">%s</span>`, emailMuted, esc(f.drop))
		}
		w := f.width
		if w < 2 {
			w = 2
		}
		if w > 100 {
			w = 100
		}
		bar := accent
		if f.warn {
			bar = "#e2606e"
		}
		fmt.Fprintf(b, `<tr><td style="padding:8px 0 4px;font-size:13px;color:%s">%s</td><td align="right" style="padding:8px 0 4px;font-size:13px;font-weight:700;color:%s;white-space:nowrap">%d%s</td></tr>`,
			emailInk, esc(f.label), emailInk, f.count, drop)
		fmt.Fprintf(b, `<tr><td colspan="2"><table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr><td style="background:%s;border-radius:5px;height:8px;font-size:0;line-height:0"><table role="presentation" width="%d%%" cellpadding="0" cellspacing="0"><tr><td style="background:%s;border-radius:5px;height:8px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr></table></td></tr>`,
			emailLine, w, bar)
	}
	b.WriteString(`</table>`)
}

// emailBoardRow: leaderboard line - rank badge, name, right-aligned value.
type emailBoardRow struct {
	rank  int
	name  string
	value string
}

// emailItem is one row of a digest list (e.g. "your events tomorrow"): a title
// with its own links and (optionally) the event's cover/GIF as a thumbnail.
type emailItem struct {
	title, when, url, muteURL, cover string
}

// themeAccent maps an event theme to its accent gradient pair - mirrors the
// .theme-* --accent tokens in styles.css (keep in sync). Empty theme → brand coral.
func themeAccent(theme string) (string, string) {
	switch theme {
	case "party":
		return "#e0559b", "#b03a7a"
	case "beach":
		return "#f0993a", "#d3752f"
	case "forest":
		return "#3f9d6f", "#2b7a52"
	case "night":
		return "#8b83ff", "#5f57d6"
	case "neon":
		return "#ff2d94", "#b01c67"
	case "cozy":
		return "#df8038", "#b05f22"
	case "analytics":
		// Owner digest only - a cool teal no event theme uses, so the daily
		// numbers are recognizable in the inbox at a glance.
		return "#2a9d8f", "#1d7268"
	}
	return emailAccent, emailAccnt2
}

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
	cta2Label string         // optional secondary button (ghost style)
	cta2URL   string
	moreLabel string // optional centered text link under the buttons
	moreURL   string
	logoURL   string      // hosted PNG logo (APP_ORIGIN/apple-touch-icon.png)
	unsubURL  string      // optional one-click mute link for THIS recipient
	coverURL  string      // optional event cover/GIF banner (https only - mail clients block data: URIs)
	theme     string      // optional event theme - tints the header/CTA to match the event page
	items     []emailItem // optional digest list (e.g. multiple events tomorrow)
	hero      *emailHero        // optional giant stat tile
	funnel    []emailFunnelStep // optional drop-off funnel with bars
	funnelT   string            // funnel section title
	tiers     []emailFunnelStep // optional second bar section (free-tier runway)
	tiersT    string
	board     []emailBoardRow   // optional leaderboard
	boardT    string            // leaderboard section title
}

func esc(s string) string { return html.EscapeString(s) }

// renderEmail composes the branded document. Structure: hidden preheader → dark
// gradient header with the logo + wordmark → frosted content card (heading,
// paragraphs, optional quote, optional meta table, coral CTA) → muted footer.
func renderEmail(c emailContent) string {
	var b strings.Builder
	accent, accent2 := themeAccent(c.theme)

	// Hidden preheader - the grey preview text next to the subject in most inboxes.
	if c.preheader != "" {
		fmt.Fprintf(&b, `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:%s">%s</div>`,
			emailBG, esc(c.preheader))
	}

	// Outer wrapper.
	fmt.Fprintf(&b, `<div style="margin:0;padding:24px 12px;background:%s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:%s">`,
		emailBG, emailInk)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto"><tr><td>`)

	// Header - brand gradient bar with logo + wordmark.
	logo := ""
	if c.logoURL != "" {
		logo = fmt.Sprintf(`<img src="%s" width="34" height="34" alt="" style="vertical-align:middle;border-radius:9px;margin-right:10px">`, esc(c.logoURL))
	}
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:linear-gradient(120deg,%s,%s);border-radius:14px 14px 0 0"><tr><td style="padding:18px 24px">%s<span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#fff;vertical-align:middle">Whensdays</span></td></tr></table>`,
		accent, accent2, logo)

	// Content card.
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%s;border:1px solid %s;border-top:none;border-radius:0 0 14px 14px"><tr><td style="padding:28px 24px">`,
		emailPanel, emailLine)

	// Event cover / GIF banner (https-only; Gmail & friends strip data: URIs).
	if c.coverURL != "" {
		fmt.Fprintf(&b, `<img src="%s" alt="" width="512" style="width:100%%;max-height:220px;object-fit:cover;border-radius:10px;margin:0 0 16px;display:block">`, esc(c.coverURL))
	}

	fmt.Fprintf(&b, `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:700;color:%s">%s</h1>`,
		emailInk, esc(c.heading))

	for _, ln := range c.lines {
		fmt.Fprintf(&b, `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:%s">%s</p>`, emailInk, esc(ln))
	}

	if c.hero != nil {
		sub := ""
		if c.hero.sub != "" {
			sub = fmt.Sprintf(`<div style="font-size:14px;font-weight:600;color:%s;margin-top:8px">%s</div>`, emailInk, esc(c.hero.sub))
		}
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td align="center" style="padding:24px 16px;background:%s;border:1px solid %s;border-top:3px solid %s;border-radius:12px">`+
			`<div style="font-size:48px;font-weight:800;letter-spacing:-0.03em;color:%s;line-height:1">%s</div>`+
			`<div style="font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:%s;margin-top:8px">%s</div>%s</td></tr></table>`,
			emailBG, emailLine, accent, accent, esc(c.hero.number), emailMuted, esc(c.hero.label), sub)
	}

	renderBars(&b, accent, c.funnelT, c.funnel)
	renderBars(&b, accent, c.tiersT, c.tiers)

	if len(c.board) > 0 {
		if c.boardT != "" {
			fmt.Fprintf(&b, `<div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:%s;margin:0 0 8px">%s</div>`, emailMuted, esc(c.boardT))
		}
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">`)
		for _, r := range c.board {
			fmt.Fprintf(&b, `<tr><td style="padding:6px 0;width:30px"><span style="display:inline-block;width:22px;height:22px;border-radius:50%%;background:%s;color:#fff;font-size:12px;font-weight:800;text-align:center;line-height:22px">%d</span></td>`+
				`<td style="padding:6px 8px;font-size:14px;font-weight:600;color:%s">%s</td>`+
				`<td align="right" style="padding:6px 0;font-size:13px;color:%s;white-space:nowrap">%s</td></tr>`,
				accent, r.rank, emailInk, esc(r.name), emailMuted, esc(r.value))
		}
		b.WriteString(`</table>`)
	}

	if c.quote != "" {
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px"><tr><td style="padding:12px 16px;background:%s;border-left:3px solid %s;border-radius:8px;font-size:15px;line-height:1.5;color:%s">%s</td></tr></table>`,
			emailBG, accent, emailInk, esc(c.quote))
	}

	// Digest list: one bordered row per event - cover thumbnail (when https)
	// on the left, title/summary/links on the right.
	for _, it := range c.items {
		thumb := ""
		if it.cover != "" {
			thumb = fmt.Sprintf(`<td style="width:68px;vertical-align:top;padding:10px 0 10px 12px"><img src="%s" width="56" height="56" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px;display:block"></td>`, esc(it.cover))
		}
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;background:%s;border:1px solid %s;border-radius:10px"><tr>%s<td style="padding:12px 16px"><span style="font-size:15px;font-weight:700;color:%s">%s</span><br><span style="font-size:13px;color:%s">%s</span><br><a href="%s" style="font-size:13px;color:%s;font-weight:600;text-decoration:none">View →</a>&nbsp;&nbsp;<a href="%s" style="font-size:12px;color:%s;text-decoration:underline">mute</a></td></tr></table>`,
			emailBG, emailLine, thumb, emailInk, esc(it.title), emailMuted, esc(it.when), esc(it.url), accent, esc(it.muteURL), emailMuted)
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
		b.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 4px"><tr>`)
		fmt.Fprintf(&b, `<td style="border-radius:10px;background:linear-gradient(120deg,%s,%s)"><a href="%s" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;border-radius:10px">%s</a></td>`,
			accent, accent2, esc(c.ctaURL), esc(c.ctaLabel))
		// Secondary action (e.g. "Can't make it") as a quiet ghost button.
		if c.cta2URL != "" && c.cta2Label != "" {
			fmt.Fprintf(&b, `<td style="width:10px"></td><td style="border-radius:10px;border:1px solid %s"><a href="%s" style="display:inline-block;padding:11px 20px;font-size:15px;font-weight:600;color:%s;text-decoration:none;border-radius:10px">%s</a></td>`,
				emailLine, esc(c.cta2URL), esc(emailInk), esc(c.cta2Label))
		}
		b.WriteString(`</tr></table>`)
	}
	if c.moreURL != "" && c.moreLabel != "" {
		fmt.Fprintf(&b, `<p style="margin:10px 0 0;font-size:13px"><a href="%s" style="color:%s;text-decoration:underline">%s</a></p>`,
			esc(c.moreURL), emailMuted, esc(c.moreLabel))
	}

	b.WriteString(`</td></tr></table>`)

	// Footer - includes the one-click mute link when the caller supplied a
	// per-recipient token.
	unsub := ""
	if c.unsubURL != "" {
		unsub = fmt.Sprintf(`<br><a href="%s" style="color:%s;text-decoration:underline">Mute notifications for this event</a>`, esc(c.unsubURL), emailMuted)
	}
	// CAN-SPAM: commercial email needs a physical postal address. Optional
	// (EMAIL_POSTAL_ADDRESS env - a PO box works); renders nothing when unset.
	postal := ""
	if pa := os.Getenv("EMAIL_POSTAL_ADDRESS"); pa != "" {
		postal = "<br>" + esc(pa)
	}
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 24px;text-align:center;font-size:12px;line-height:1.5;color:%s">You're receiving this because you're part of this plan on Whensdays.<br>Whensdays - scheduling that actually happens.%s%s</td></tr></table>`,
		emailMuted, postal, unsub)

	b.WriteString(`</td></tr></table></div>`)
	return b.String()
}
