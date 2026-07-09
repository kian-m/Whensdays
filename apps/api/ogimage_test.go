package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestComposeOGCardWithCover(t *testing.T) {
	cover := image.NewRGBA(image.Rect(0, 0, 420, 420))
	for y := 0; y < 420; y++ {
		for x := 0; x < 420; x++ {
			cover.SetRGBA(x, y, color.RGBA{40, 120, 200, 255})
		}
	}
	card := composeOGCard(cover, "Alex Host", "Dinner", 4)
	if got := card.Bounds(); got.Dx() != ogW || got.Dy() != ogH {
		t.Fatalf("card = %dx%d, want %dx%d", got.Dx(), got.Dy(), ogW, ogH)
	}
	// The cover fills the card: mid-pixel keeps the cover's hue (scrim-free zone).
	c := card.RGBAAt(ogW/2, ogH/2)
	if c.B < c.R {
		t.Fatalf("center pixel %v does not look like the blue cover", c)
	}
}

func TestComposeOGCardFallback(t *testing.T) {
	card := composeOGCard(nil, "Alex", "Camping weekend", 0)
	if got := card.Bounds(); got.Dx() != ogW || got.Dy() != ogH {
		t.Fatalf("card = %dx%d", got.Dx(), got.Dy())
	}
	// Brand gradient: navy-ish at bottom-left.
	c := card.RGBAAt(10, ogH-10)
	if c.B < c.R {
		t.Fatalf("fallback bottom pixel %v not navy", c)
	}
}

func TestComposeOGCardSocialProof(t *testing.T) {
	// going >= 2 renders the coral "N in so far" line; the exact pixels vary
	// with the font, so compare against the same card without it.
	with := composeOGCard(nil, "Alex", "Dinner", 5)
	without := composeOGCard(nil, "Alex", "Dinner", 0)
	diff := 0
	for x := 48; x < 400; x++ {
		for y := 140; y < 190; y++ {
			if with.RGBAAt(x, y) != without.RGBAAt(x, y) {
				diff++
			}
		}
	}
	if diff == 0 {
		t.Fatal("social-proof line did not render")
	}
	// A lone going (just the host) must NOT render it.
	lone := composeOGCard(nil, "Alex", "Dinner", 1)
	for x := 48; x < 400; x++ {
		for y := 140; y < 190; y++ {
			if lone.RGBAAt(x, y) != without.RGBAAt(x, y) {
				t.Fatal("going=1 should not draw social proof")
			}
		}
	}
}

func TestLoadCoverDataURL(t *testing.T) {
	// Round-trip a real encoded PNG as a data URL.
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	u := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	s := &server{}
	if img := s.loadCover(u); img == nil {
		t.Fatal("data URL cover should decode")
	}
	if img := s.loadCover("data:image/png;base64,!!!"); img != nil {
		t.Fatal("bad base64 should return nil")
	}
	if img := s.loadCover("https://evil.example/x.gif"); img != nil {
		t.Fatal("non-klipy remote must not be fetched")
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("héllo wörld this is long", 10); len([]rune(got)) != 10 {
		t.Fatalf("truncate = %q", got)
	}
}
