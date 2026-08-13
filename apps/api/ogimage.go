package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	_ "image/jpeg" // register decoder for data-URL covers
	"image/png"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"

	"github.com/clsandbox/api/internal/db"
)

// ogimage.go - the per-event social card behind og:image. When an invite link
// is texted/posted, the unfurl shows the event's cover (photo or the gif's
// first frame) as a big 1200×630 tile with the host's name top-left and the
// logo top-right; cover-less events get a brand-gradient card with the title.
// Unauthenticated like the OG page itself: link scrapers send no bearer, and
// the event id IS the invite capability (same fields the unfurl already leaks).

//go:embed assets/logo-96.png
var logoPNG []byte

const (
	ogW = 1200
	ogH = 630
)

var (
	ogLogo     image.Image
	ogBoldFace font.Face
	ogRegFace  font.Face
)

func init() {
	if img, err := png.Decode(bytes.NewReader(logoPNG)); err == nil {
		ogLogo = img
	}
	if f, err := opentype.Parse(gobold.TTF); err == nil {
		ogBoldFace, _ = opentype.NewFace(f, &opentype.FaceOptions{Size: 46, DPI: 72, Hinting: font.HintingFull})
	}
	if f, err := opentype.Parse(goregular.TTF); err == nil {
		ogRegFace, _ = opentype.NewFace(f, &opentype.FaceOptions{Size: 30, DPI: 72, Hinting: font.HintingFull})
	}
}

func (s *server) handleEventOGImage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	ev, err := s.queries.GetEvent(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.internal(w, "og image: load event", err)
		return
	}
	hostName := ""
	if p, perr := s.queries.GetProfile(r.Context(), ev.HostID); perr == nil {
		hostName = p.DisplayName
	}
	going := 0
	if n, cerr := s.queries.CountGoing(r.Context(), id); cerr == nil {
		going = int(n)
	}

	cover := s.loadCover(ev.PhotoUrl)
	card := composeOGCard(cover, hostName, ev.Title, going)

	var buf bytes.Buffer
	if err := png.Encode(&buf, card); err != nil {
		s.internal(w, "og image: encode", err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	// Short cache: titles/names/covers are editable, but scrapers hammer.
	w.Header().Set("Cache-Control", "public, max-age=600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// groupInviterName returns the sharer's display name for the group invite
// preview, but ONLY when `from` is genuinely a member - so the public OG
// endpoint can't be used as a name-lookup oracle for arbitrary user ids.
func (s *server) groupInviterName(ctx context.Context, id pgtype.UUID, from string) string {
	if from == "" {
		return ""
	}
	if m, err := s.queries.IsGroupMember(ctx, db.IsGroupMemberParams{ID: id, UserID: from}); err != nil || !m {
		return ""
	}
	if p, err := s.queries.GetProfile(ctx, from); err == nil {
		return p.DisplayName
	}
	return ""
}

// handleGroupOGImage composites the 1200×630 group-invite card: the group's
// icon/gif (or a brand gradient), the inviter line, and the group name.
// Unauthenticated - the group id is the invite capability, same as events.
func (s *server) handleGroupOGImage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	g, err := s.queries.GetGroup(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.internal(w, "group og image: load", err)
		return
	}
	inviter := s.groupInviterName(r.Context(), id, r.URL.Query().Get("from"))
	card := composeGroupOGCard(s.loadCover(g.IconUrl), inviter, g.Name)
	var buf bytes.Buffer
	if err := png.Encode(&buf, card); err != nil {
		s.internal(w, "group og image: encode", err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// composeGroupOGCard mirrors composeOGCard for a group invite: icon/gif fill (or
// the plum brand fallback), a scrim for legibility, the inviter line top-left,
// and the group name across the bottom.
func composeGroupOGCard(icon image.Image, inviterName, groupName string) *image.RGBA {
	card := image.NewRGBA(image.Rect(0, 0, ogW, ogH))
	fallback := icon == nil
	if !fallback {
		drawCoverFill(card, icon)
	} else {
		drawBrandFallback(card)
	}
	drawScrim(card, 0, 170, 0.62)
	drawScrim(card, ogH-200, ogH, 0.40)
	titleColor := color.Color(color.White)
	if fallback {
		titleColor = ogCream // cream Fraunces-ish type on the plum stage
	}
	if inviterName != "" {
		drawText(card, ogBoldFace, truncate(inviterName, 28), 48, 84, titleColor)
		drawText(card, ogRegFace, "invites you to join", 48, 126, color.RGBA{235, 226, 218, 235})
	} else {
		drawText(card, ogRegFace, "You're invited to join", 48, 96, color.RGBA{235, 226, 218, 235})
	}
	drawText(card, ogBoldFace, truncate(groupName, 30), 48, ogH-72, titleColor)
	if ogLogo != nil {
		b := ogLogo.Bounds()
		pos := image.Rect(ogW-48-b.Dx(), 40, ogW-48, 40+b.Dy())
		draw.Draw(card, pos, ogLogo, b.Min, draw.Over)
	}
	if fallback {
		drawStripeBar(card, 0, ogStripeH)
	}
	return card
}

// maxCoverPixels caps decode dimensions: bytes are already bounded, but a tiny
// compressed image can decode to gigapixels (a decompression/pixel bomb) and
// spike memory. 25MP (e.g. 5000×5000) is far above any real cover.
const maxCoverPixels = 25_000_000

// safeDecode checks the header dimensions BEFORE allocating the full pixel
// buffer, rejecting oversized images.
func safeDecode(b []byte) image.Image {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width*cfg.Height > maxCoverPixels || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil
	}
	return img
}

// loadCover decodes an event cover: an uploaded data URL, or a Klipy CDN gif
// (first frame). Any failure returns nil → the branded fallback card.
func (s *server) loadCover(u string) image.Image {
	switch {
	case strings.HasPrefix(u, "data:image/"):
		i := strings.Index(u, ";base64,")
		if i < 0 {
			return nil
		}
		raw, err := base64.StdEncoding.DecodeString(u[i+8:])
		if err != nil {
			return nil
		}
		return safeDecode(raw)
	case strings.HasPrefix(u, "https://static.klipy.com/"):
		client := safeHTTPClient(5 * time.Second)
		resp, err := client.Get(u)
		if err != nil {
			return nil
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return nil
		}
		// Bound gif dimensions the same way before decoding all frames.
		if cfg, err := gif.DecodeConfig(bytes.NewReader(body)); err == nil && cfg.Width*cfg.Height <= maxCoverPixels {
			if img, err := gif.Decode(bytes.NewReader(body)); err == nil {
				return img // first frame
			}
		}
		return safeDecode(body)
	}
	return nil
}

// composeOGCard draws the 1200×630 unfurl tile: cover (center-cropped to fill)
// or the plum brand fallback, a legibility scrim, host name top-left, logo
// top-right, and - on the fallback - the event title + candy-stripe rule.
func composeOGCard(cover image.Image, hostName, title string, going int) *image.RGBA {
	card := image.NewRGBA(image.Rect(0, 0, ogW, ogH))

	fallback := cover == nil
	if !fallback {
		drawCoverFill(card, cover)
	} else {
		drawBrandFallback(card)
	}

	// Scrim: darken the top band so white text reads on any cover (taller when
	// the social-proof line renders below "invites you").
	scrimBottom := 170
	if going >= 2 {
		scrimBottom = 216
	}
	drawScrim(card, 0, scrimBottom, 0.62)
	if fallback && title != "" {
		drawScrim(card, ogH-200, ogH, 0.35)
	}

	// House Lights: cream Fraunces-ish type on the plum stage fallback; a real
	// cover keeps white (the scrim makes it legible over any photo).
	titleColor := color.Color(color.White)
	if fallback {
		titleColor = ogCream
	}

	if hostName != "" {
		drawText(card, ogBoldFace, truncate(hostName, 28), 48, 84, titleColor)
		drawText(card, ogRegFace, "invites you", 48, 126, color.RGBA{235, 226, 218, 235})
	}
	// Social pressure on the card itself: the group chat sees momentum before
	// anyone taps. One going = just the host, so it starts at two. Coral
	// matches --accent exactly, so it reads the same across cover/fallback.
	if going >= 2 {
		drawText(card, ogBoldFace, fmt.Sprintf("%d in so far", going), 48, 172, color.RGBA{238, 108, 77, 255})
	}
	if fallback && title != "" {
		drawText(card, ogBoldFace, truncate(title, 34), 48, ogH-72, titleColor)
	}
	if ogLogo != nil {
		b := ogLogo.Bounds()
		pos := image.Rect(ogW-48-b.Dx(), 40, ogW-48, 40+b.Dy())
		draw.Draw(card, pos, ogLogo, b.Min, draw.Over)
	}
	if fallback {
		drawStripeBar(card, 0, ogStripeH)
	}
	return card
}

// drawCoverFill center-crops the cover to the card's aspect and scales it up.
func drawCoverFill(dst *image.RGBA, src image.Image) {
	sb := src.Bounds()
	srcAR := float64(sb.Dx()) / float64(sb.Dy())
	dstAR := float64(ogW) / float64(ogH)
	crop := sb
	if srcAR > dstAR { // too wide → trim sides
		w := int(float64(sb.Dy()) * dstAR)
		x0 := sb.Min.X + (sb.Dx()-w)/2
		crop = image.Rect(x0, sb.Min.Y, x0+w, sb.Max.Y)
	} else { // too tall → trim top/bottom
		h := int(float64(sb.Dx()) / dstAR)
		y0 := sb.Min.Y + (sb.Dy()-h)/2
		crop = image.Rect(sb.Min.X, y0, sb.Max.X, y0+h)
	}
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, xdraw.Src, nil)
}

// ogPlum/ogCream mirror --bg/--cream in styles.css - the House Lights stage
// and its ink, used for the no-cover fallback card.
var (
	ogPlum  = color.RGBA{26, 20, 36, 255}    // #1a1424
	ogCream = color.RGBA{248, 227, 201, 255} // #f8e3c9
)

// ogStripeH is the candy-stripe bar's height on the 1200×630 card - scaled up
// from the web's 3px hero rule for a card viewed at a distance.
const ogStripeH = 10

// ogStripe mirrors --stripe in styles.css: coral/amber/teal/cream quarters.
var ogStripe = [4]color.RGBA{
	{238, 108, 77, 255},  // coral #ee6c4d
	{233, 161, 59, 255},  // amber #e9a13b
	{58, 163, 139, 255},  // teal  #3aa38b
	{248, 227, 201, 255}, // cream #f8e3c9
}

// drawBrandFallback paints the no-cover fallback: a solid plum stage - House
// Lights reserves gradients for the candy stripe only, so the old dusk/coral
// glow gradient is gone. drawStripeBar (called by the composer) adds the
// stripe rule that replaces it as the fallback's brand flourish.
func drawBrandFallback(dst *image.RGBA) {
	for y := 0; y < ogH; y++ {
		for x := 0; x < ogW; x++ {
			dst.SetRGBA(x, y, ogPlum)
		}
	}
}

// drawStripeBar paints the candy-stripe rule (coral/amber/teal/cream
// quarters) across the full width between y0 and y1 - the fallback card's
// analog of the hero card's 3px --stripe top rule on the web.
func drawStripeBar(dst *image.RGBA, y0, y1 int) {
	seg := ogW / len(ogStripe)
	for i, c := range ogStripe {
		x0, x1 := i*seg, i*seg+seg
		if i == len(ogStripe)-1 {
			x1 = ogW
		}
		for y := y0; y < y1 && y < ogH; y++ {
			for x := x0; x < x1; x++ {
				dst.SetRGBA(x, y, c)
			}
		}
	}
}

// drawScrim multiplies a vertical band toward black (alpha 0..1 at its darkest
// edge, fading across the band).
func drawScrim(dst *image.RGBA, y0, y1 int, strength float64) {
	for y := y0; y < y1 && y < ogH; y++ {
		f := 1 - strength*(1-float64(y-y0)/float64(y1-y0)) // darkest at y0
		if y0 > ogH/2 {
			f = 1 - strength*(float64(y-y0)/float64(y1-y0)) // darkest at y1
		}
		for x := 0; x < ogW; x++ {
			c := dst.RGBAAt(x, y)
			dst.SetRGBA(x, y, color.RGBA{uint8(float64(c.R) * f), uint8(float64(c.G) * f), uint8(float64(c.B) * f), 255})
		}
	}
}

func drawText(dst *image.RGBA, face font.Face, s string, x, y int, c color.Color) {
	if face == nil {
		return
	}
	d := font.Drawer{Dst: dst, Src: image.NewUniform(c), Face: face, Dot: fixed.P(x, y)}
	d.DrawString(s)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

var _ = db.Event{} // keep the db import when handlers move
