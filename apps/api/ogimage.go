package main

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"errors"
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
	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"

	"github.com/clsandbox/api/internal/db"
)

// ogimage.go — the per-event social card behind og:image. When an invite link
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

	cover := s.loadCover(ev.PhotoUrl)
	card := composeOGCard(cover, hostName, ev.Title)

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
		img, _, err := image.Decode(bytes.NewReader(raw))
		if err != nil {
			return nil
		}
		return img
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
		if img, err := gif.Decode(bytes.NewReader(body)); err == nil {
			return img // first frame
		}
		img, _, err := image.Decode(bytes.NewReader(body))
		if err != nil {
			return nil
		}
		return img
	}
	return nil
}

// composeOGCard draws the 1200×630 unfurl tile: cover (center-cropped to fill)
// or a brand gradient, a legibility scrim, host name top-left, logo top-right,
// and — on the fallback — the event title.
func composeOGCard(cover image.Image, hostName, title string) *image.RGBA {
	card := image.NewRGBA(image.Rect(0, 0, ogW, ogH))

	if cover != nil {
		drawCoverFill(card, cover)
	} else {
		drawBrandGradient(card)
	}

	// Scrim: darken the top band so white text reads on any cover.
	drawScrim(card, 0, 170, 0.62)
	if cover == nil && title != "" {
		drawScrim(card, ogH-200, ogH, 0.35)
	}

	if hostName != "" {
		drawText(card, ogBoldFace, truncate(hostName, 28), 48, 84, color.White)
		drawText(card, ogRegFace, "invites you", 48, 126, color.RGBA{235, 226, 218, 235})
	}
	if cover == nil && title != "" {
		drawText(card, ogBoldFace, truncate(title, 34), 48, ogH-72, color.White)
	}
	if ogLogo != nil {
		b := ogLogo.Bounds()
		pos := image.Rect(ogW-48-b.Dx(), 40, ogW-48, 40+b.Dy())
		draw.Draw(card, pos, ogLogo, b.Min, draw.Over)
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

// drawBrandGradient paints the no-cover fallback: dusk navy with a coral glow.
func drawBrandGradient(dst *image.RGBA) {
	top := [3]float64{22, 32, 58}    // #16203a
	bot := [3]float64{14, 18, 32}    // #0e1220
	coral := [3]float64{238, 108, 77}
	for y := 0; y < ogH; y++ {
		t := float64(y) / ogH
		r0, g0, b0 := top[0]+(bot[0]-top[0])*t, top[1]+(bot[1]-top[1])*t, top[2]+(bot[2]-top[2])*t
		for x := 0; x < ogW; x++ {
			// Radial coral glow anchored top-right, like the sky.
			dx, dy := float64(x-900)/700, float64(y-40)/400
			g := 0.42 - (dx*dx+dy*dy)*0.42
			if g < 0 {
				g = 0
			}
			dst.SetRGBA(x, y, color.RGBA{
				uint8(r0 + (coral[0]-r0)*g), uint8(g0 + (coral[1]-g0)*g), uint8(b0 + (coral[2]-b0)*g), 255,
			})
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
