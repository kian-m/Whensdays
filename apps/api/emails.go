package main

import (
	"fmt"
	"html"
	"os"
	"strconv"
	"strings"
)

// emails.go - the branded HTML for transactional email. Whensdays' look is
// House Lights (see styles.css): a small theater just before the show starts
// - plum stage, cream paper, the wordmark's candy stripe as functional color.
// Email clients strip <style>/<link> and external CSS, so everything here is
// inline and table-based (the only layout that survives Outlook/Gmail). The
// header stays on the dark plum stage; the content card is the cream "paper"
// so body copy reads like a playbill program, not a dashboard. Copy is warm
// and short - these are coordination nudges, not marketing.
//
// Every in-email link is UTM-tagged (campaignURL) so PostHog attributes the
// resulting visit to email: it auto-captures utm_* on the landing pageview and
// the web forwards them into the distinct person timeline. One campaign value
// per email type keeps the funnel legible (email_finalized, email_reminder, …).

// brand palette - mirrors the House Lights tokens in styles.css. Email
// clients don't do a reliable dark/light switch, so the card always renders
// as the cream "matinee" panel (readable body copy); the header/footer stay
// on the dark plum stage to bookend it, same as the web app's default look.
const (
	emailStage      = "#1a1424" // --bg (dark) - outer wrapper + header, "the stage"
	emailStageInk   = "#f2e9dc" // --ink (dark) - text on the plum stage/header
	emailStageMuted = "#a596b4" // --muted (dark) - secondary text on the stage (footer)
	emailCream      = "#f8e3c9" // --cream - content panel background (the paper)
	emailInk        = "#2f2440" // --plum / paper --ink - primary text on the cream panel
	emailPlumText   = "#2f2440" // --plum - button text on any accent fill (never white/cream)
	emailMuted      = "#6f6280" // paper --muted - secondary text on the cream panel
	emailAccent     = "#ee6c4d" // --accent - coral, action only
	emailAccentDeep = "#c14e33" // paper --accent-deep - coral border/ring (4.4:1 on paper)
	emailAmber      = "#9c6614" // paper --time - amber deepened for the cream panel (4.5:1)
	emailGo         = "#2b7f6c" // paper --go - teal
	emailNo         = "#c14458" // paper --no - rose, warn/danger bars
	emailLine       = "#e5dccb" // paper --line - hairline borders
	emailSurface2   = "#f3ecdd" // paper --surface-2 - quote/board/item row wash
	// emailMono is the stamp-voice font stack (mirrors --font-data) in
	// email-safe terms - every mail client falls through to a real monospace.
	emailMono = "ui-monospace,'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace"
)

// emailStripe mirrors --stripe in styles.css: coral/amber/teal/cream quarters.
// Rendered as a 4-cell table row of solid colors rather than a CSS gradient -
// the doc's documented "acceptable fallback", since Outlook desktop's Word
// rendering engine drops background gradients on table cells.
var emailStripe = [4]string{"#ee6c4d", "#e9a13b", "#3aa38b", "#f8e3c9"}

// darkenHex scales an "#rrggbb" color's channels by factor (0..1) for a
// deeper border/ring shade. The .theme-* classes in styles.css only define a
// single --accent override per theme (no per-theme "deep" pair), so email
// derives one programmatically instead of inventing colors the web never
// uses - the default coral case still uses the real, contrast-checked paper
// --accent-deep value.
func darkenHex(hex string, factor float64) string {
	hex = strings.TrimPrefix(hex, "#")
	if len(hex) != 6 {
		return "#" + hex
	}
	scale := func(h string) int {
		v, _ := strconv.ParseInt(h, 16, 0)
		n := int(float64(v) * factor)
		if n < 0 {
			n = 0
		}
		if n > 255 {
			n = 255
		}
		return n
	}
	return fmt.Sprintf("#%02x%02x%02x", scale(hex[0:2]), scale(hex[2:4]), scale(hex[4:6]))
}

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

// emailMetaRow is a labelled fact shown in the event summary block (When /
// Where). mono marks a date/time (or count) value for stamp-voice rendering
// (mono, uppercase, amber) - §1.5: dates/times/counts always use it, nothing
// else does. "Where" (a location string) leaves it false.
type emailMetaRow struct {
	label, value string
	mono         bool
}

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
			bar = emailNo
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
// whenIsStamp marks `when` as a genuine date/time (stamp voice: mono, amber,
// uppercase) rather than an activity summary ("Maya is going · Dev: …") -
// only the reminder and follow digests set it; the activity digest's `when`
// is prose, never mono. page/rsvpGoingURL/rsvpDeclinedURL are optional (the
// follow digest, V3, is the only caller that sets them).
type emailItem struct {
	title, when, url, muteURL, cover string
	whenIsStamp                      bool
	page                             string // optional page attribution ("via {group/host}")
	rsvpGoingURL, rsvpDeclinedURL    string // optional one-tap RSVP links (rsvp| pattern)
}

// emailUnfollowLink is one "Following {Page} - unfollow" footer line - the
// follow digest can carry several (one per distinct followed page in the
// email), each with its own follow|<uid>|<kind>|<value> token.
type emailUnfollowLink struct{ label, url string }

// themeAccent maps an event theme to its fill + border colors. Fill mirrors
// the single .theme-* --accent override in styles.css exactly (keep in sync
// whenever a theme hue changes there); border is a darkened shade for the CTA
// button's 1px ring, in the spirit of the default coral's real accent/
// accent-deep pairing (styles.css doesn't define a per-theme deep, so email
// derives one instead of inventing an un-sanctioned color). Empty/unknown
// theme → brand coral.
func themeAccent(theme string) (fill, border string) {
	switch theme {
	case "party":
		fill = "#e0559b"
	case "beach":
		fill = "#f0993a"
	case "forest":
		fill = "#3f9d6f"
	case "night":
		fill = "#8b83ff"
	case "neon":
		fill = "#ff2d94"
	case "cozy":
		fill = "#df8038"
	case "analytics":
		// Owner digest only - a teal no event theme uses (matches the paper
		// --go token), so the daily numbers are recognizable in the inbox.
		fill = emailGo
	default:
		return emailAccent, emailAccentDeep
	}
	return fill, darkenHex(fill, 0.72)
}

// emailContent is the variable payload for one message; renderEmail turns it into
// a full, client-safe HTML document.
type emailContent struct {
	preheader     string         // hidden inbox-preview line
	heading       string         // big title inside the card
	lines         []string       // body paragraphs (plain text, escaped here)
	meta          []emailMetaRow // optional When/Where facts
	quote         string         // optional highlighted snippet (e.g. a comment)
	ctaLabel      string         // button text
	ctaURL        string         // button href (already UTM-tagged by the caller)
	cta2Label     string         // optional secondary button (ghost style)
	cta2URL       string
	moreLabel     string // optional centered text link under the buttons
	moreURL       string
	logoURL       string            // hosted PNG logo (APP_ORIGIN/apple-touch-icon.png)
	unsubURL      string            // optional one-click mute link for THIS recipient
	coverURL      string            // optional event cover/GIF banner (https only - mail clients block data: URIs)
	theme         string            // optional event theme - tints the CTA/quote/hero to match the event page
	items         []emailItem       // optional digest list (e.g. multiple events tomorrow)
	hero          *emailHero        // optional giant stat tile
	funnel        []emailFunnelStep // optional drop-off funnel with bars
	funnelT       string            // funnel section title
	tiers         []emailFunnelStep // optional second bar section (free-tier runway)
	tiersT        string
	board         []emailBoardRow     // optional leaderboard
	boardT        string              // leaderboard section title
	unfollowLinks []emailUnfollowLink // optional per-page unfollow footer lines (follow digest)
}

func esc(s string) string { return html.EscapeString(s) }

// renderEmail composes the branded document. Structure: hidden preheader →
// solid plum header (logo + wordmark) → candy-stripe rule → cream content
// card (heading, paragraphs, optional quote, optional meta table, coral CTA
// with plum text) → footer on the plum stage.
func renderEmail(c emailContent) string {
	var b strings.Builder
	accent, border := themeAccent(c.theme)

	// Hidden preheader - the grey preview text next to the subject in most inboxes.
	if c.preheader != "" {
		fmt.Fprintf(&b, `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:%s">%s</div>`,
			emailStage, esc(c.preheader))
	}

	// Outer wrapper - the plum stage.
	fmt.Fprintf(&b, `<div style="margin:0;padding:24px 12px;background:%s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:%s">`,
		emailStage, emailStageInk)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto"><tr><td>`)

	// Header - solid plum with the logo + wordmark (no gradient).
	logo := ""
	if c.logoURL != "" {
		logo = fmt.Sprintf(`<img src="%s" width="34" height="34" alt="" style="vertical-align:middle;border-radius:9px;margin-right:10px">`, esc(c.logoURL))
	}
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%s;border-radius:14px 14px 0 0"><tr><td style="padding:20px 24px">%s<span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:%s;vertical-align:middle">Whensdays</span></td></tr></table>`,
		emailStage, logo, emailCream)

	// Candy-stripe rule under the header - coral/amber/teal/cream quarters.
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`)
	for _, seg := range emailStripe {
		fmt.Fprintf(&b, `<td width="25%%" style="height:3px;line-height:3px;font-size:0;background:%s">&nbsp;</td>`, seg)
	}
	b.WriteString(`</tr></table>`)

	// Content card - the cream paper.
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%s;border:1px solid %s;border-top:none;border-radius:0 0 14px 14px"><tr><td style="padding:28px 24px">`,
		emailCream, emailLine)

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
			sub = fmt.Sprintf(`<div style="font-size:14px;font-weight:600;color:%s;margin-top:8px">%s</div>`, emailStageInk, esc(c.hero.sub))
		}
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td align="center" style="padding:24px 16px;background:%s;border-top:3px solid %s;border-radius:12px">`+
			`<div style="font-size:48px;font-weight:800;letter-spacing:-0.03em;color:%s;line-height:1">%s</div>`+
			`<div style="font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:%s;margin-top:8px">%s</div>%s</td></tr></table>`,
			emailStage, accent, accent, esc(c.hero.number), emailStageMuted, esc(c.hero.label), sub)
	}

	renderBars(&b, accent, c.funnelT, c.funnel)
	renderBars(&b, accent, c.tiersT, c.tiers)

	if len(c.board) > 0 {
		if c.boardT != "" {
			fmt.Fprintf(&b, `<div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:%s;margin:0 0 8px">%s</div>`, emailMuted, esc(c.boardT))
		}
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">`)
		for _, r := range c.board {
			// Plum text on the accent-filled badge - never white/cream on a
			// coral (or theme-accent) fill (§1.4).
			fmt.Fprintf(&b, `<tr><td style="padding:6px 0;width:30px"><span style="display:inline-block;width:22px;height:22px;border-radius:50%%;background:%s;color:%s;font-size:12px;font-weight:800;text-align:center;line-height:22px">%d</span></td>`+
				`<td style="padding:6px 8px;font-size:14px;font-weight:600;color:%s">%s</td>`+
				`<td align="right" style="padding:6px 0;font-size:13px;color:%s;white-space:nowrap">%s</td></tr>`,
				accent, emailPlumText, r.rank, emailInk, esc(r.name), emailMuted, esc(r.value))
		}
		b.WriteString(`</table>`)
	}

	if c.quote != "" {
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px"><tr><td style="padding:12px 16px;background:%s;border-left:3px solid %s;border-radius:8px;font-size:15px;line-height:1.5;color:%s">%s</td></tr></table>`,
			emailSurface2, accent, emailInk, esc(c.quote))
	}

	// Digest list: one bordered row per event - cover thumbnail (when https)
	// on the left, title/summary/links on the right. A genuine date/time
	// (whenIsStamp) renders mono/amber/uppercase; an activity summary stays
	// plain prose.
	for _, it := range c.items {
		thumb := ""
		if it.cover != "" {
			thumb = fmt.Sprintf(`<td style="width:68px;vertical-align:top;padding:10px 0 10px 12px"><img src="%s" width="56" height="56" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px;display:block"></td>`, esc(it.cover))
		}
		// page attribution - only the follow digest sets this ("via {Page}").
		page := ""
		if it.page != "" {
			page = fmt.Sprintf(`<br><span style="font-size:12px;color:%s">via %s</span>`, emailMuted, esc(it.page))
		}
		// one-tap RSVP links - only the follow digest sets these.
		rsvp := ""
		if it.rsvpGoingURL != "" && it.rsvpDeclinedURL != "" {
			rsvp = fmt.Sprintf(`<a href="%s" style="font-size:13px;color:%s;font-weight:600;text-decoration:none">Going</a>&nbsp;&nbsp;<a href="%s" style="font-size:13px;color:%s;text-decoration:none">Can't go</a>&nbsp;&nbsp;`,
				esc(it.rsvpGoingURL), accent, esc(it.rsvpDeclinedURL), emailMuted)
		}
		whenStyle := fmt.Sprintf("font-size:13px;color:%s", emailMuted)
		if it.whenIsStamp {
			whenStyle = fmt.Sprintf("font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;font-family:%s;color:%s", emailMono, emailAmber)
		}
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;background:%s;border:1px solid %s;border-radius:10px"><tr>%s<td style="padding:12px 16px"><span style="font-size:15px;font-weight:700;color:%s">%s</span>%s<br><span style="%s">%s</span><br>%s<a href="%s" style="font-size:13px;color:%s;font-weight:600;text-decoration:none">View →</a>&nbsp;&nbsp;<a href="%s" style="font-size:12px;color:%s;text-decoration:underline">mute</a></td></tr></table>`,
			emailSurface2, emailLine, thumb, emailInk, esc(it.title), page, whenStyle, esc(it.when), rsvp, esc(it.url), accent, esc(it.muteURL), emailMuted)
	}

	if len(c.meta) > 0 {
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px">`)
		for _, m := range c.meta {
			valStyle := fmt.Sprintf("padding:6px 0;font-size:15px;font-weight:600;color:%s", emailInk)
			if m.mono {
				valStyle = fmt.Sprintf("padding:6px 0;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;font-family:%s;color:%s", emailMono, emailAmber)
			}
			fmt.Fprintf(&b, `<tr><td style="padding:6px 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:%s;width:64px;vertical-align:top">%s</td><td style="%s">%s</td></tr>`,
				emailMuted, esc(m.label), valStyle, esc(m.value))
		}
		b.WriteString(`</table>`)
	}

	if c.ctaURL != "" && c.ctaLabel != "" {
		b.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 4px"><tr>`)
		// Coral (or theme-accent) fill, PLUM text - never white/cream on a
		// fill (§1.4). A 1px darker ring stands in for the removed gradient.
		fmt.Fprintf(&b, `<td style="border-radius:10px;background:%s;border:1px solid %s"><a href="%s" style="display:inline-block;padding:11px 25px;font-size:15px;font-weight:700;color:%s;text-decoration:none;border-radius:10px">%s</a></td>`,
			accent, border, esc(c.ctaURL), emailPlumText, esc(c.ctaLabel))
		// Secondary action (e.g. "Can't make it") as a quiet ghost button.
		if c.cta2URL != "" && c.cta2Label != "" {
			fmt.Fprintf(&b, `<td style="width:10px"></td><td style="border-radius:10px;border:1px solid %s"><a href="%s" style="display:inline-block;padding:10px 19px;font-size:15px;font-weight:600;color:%s;text-decoration:none;border-radius:10px">%s</a></td>`,
				emailLine, esc(c.cta2URL), emailInk, esc(c.cta2Label))
		}
		b.WriteString(`</tr></table>`)
	}
	if c.moreURL != "" && c.moreLabel != "" {
		fmt.Fprintf(&b, `<p style="margin:10px 0 0;font-size:13px"><a href="%s" style="color:%s;text-decoration:underline">%s</a></p>`,
			esc(c.moreURL), emailMuted, esc(c.moreLabel))
	}

	b.WriteString(`</td></tr></table>`)

	// Footer - on the plum stage (outside the cream card), includes the
	// one-click mute link when the caller supplied a per-recipient token.
	unsub := ""
	if c.unsubURL != "" {
		unsub = fmt.Sprintf(`<br><a href="%s" style="color:%s;text-decoration:underline">Mute notifications for this event</a>`, esc(c.unsubURL), emailStageMuted)
	}
	// Follow digest (V3): one "Following {Page} - unfollow" line per distinct
	// page represented in this email, each its own follow|<uid>|<kind>|<value>
	// token (see followdigest.go).
	for _, u := range c.unfollowLinks {
		unsub += fmt.Sprintf(`<br><a href="%s" style="color:%s;text-decoration:underline">%s</a>`, esc(u.url), emailStageMuted, esc(u.label))
	}
	// CAN-SPAM: commercial email needs a physical postal address. Optional
	// (EMAIL_POSTAL_ADDRESS env - a PO box works); renders nothing when unset.
	postal := ""
	if pa := os.Getenv("EMAIL_POSTAL_ADDRESS"); pa != "" {
		postal = "<br>" + esc(pa)
	}
	fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 24px;text-align:center;font-size:12px;line-height:1.5;color:%s">You're receiving this because you're part of this plan on Whensdays.<br>Whensdays - scheduling that actually happens.%s%s</td></tr></table>`,
		emailStageMuted, postal, unsub)

	b.WriteString(`</td></tr></table></div>`)
	return b.String()
}
