package main

import (
	"errors"
	"net"
	"net/http"
	"sync"
	"syscall"
	"time"
)

// security.go - SSRF-hardened HTTP transport + a lightweight per-IP rate limiter.

// blockedIP reports whether an IP must never be dialed (loopback, private,
// link-local incl. cloud metadata 169.254.169.254, unspecified, CGNAT).
func blockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 100 && ip4[1]&0xC0 == 64 {
		return true // 100.64.0.0/10 CGNAT
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast()
}

// safeHTTPClient returns a client that (1) validates the ACTUAL resolved IP at
// connect time via the dialer Control hook - this fires after DNS resolution
// for the initial request AND every redirect hop, so it defeats both redirect-
// based SSRF and DNS-rebinding - and (2) caps redirects. Use for every outbound
// fetch that touches a user-influenced or third-party URL.
func safeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if ip := net.ParseIP(host); ip == nil || blockedIP(ip) {
				return errors.New("blocked address")
			}
			return nil
		},
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{DialContext: dialer.DialContext, DisableKeepAlives: true},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
}

// --- per-IP rate limiter (token bucket) for unauthenticated endpoints ---

type ipLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens per second
	burst   float64
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newIPLimiter(perMinute, burst float64) *ipLimiter {
	l := &ipLimiter{buckets: map[string]*bucket{}, rate: perMinute / 60.0, burst: burst}
	go l.gc()
	return l
}

func (l *ipLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[ip]
	if b == nil {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// gc drops idle buckets so the map can't grow unbounded (memory DoS).
func (l *ipLimiter) gc() {
	for range time.Tick(10 * time.Minute) {
		l.mu.Lock()
		cut := time.Now().Add(-15 * time.Minute)
		for ip, b := range l.buckets {
			if b.last.Before(cut) {
				delete(l.buckets, ip)
			}
		}
		l.mu.Unlock()
	}
}

// clientIP prefers Cloudflare's unspoofable header, then falls back. Behind our
// CF→Cloud Run path CF-Connecting-IP is authoritative; direct callers use
// RemoteAddr. X-Forwarded-For is intentionally NOT trusted (client-spoofable).
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimit wraps a handler with a per-IP limiter, returning 429 when exceeded.
func (l *ipLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(clientIP(r), time.Now()) {
			w.Header().Set("Retry-After", "60")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// perUserMiddleware limits by the AUTHENTICATED user id (falling back to IP).
// Used on the outbound-proxy routes (Klipy/Photon) - they're behind auth, but
// guests are cheap-to-mint users, so a per-user bucket stops one actor from
// burning the upstream free-tier quota (denial-of-wallet) for everyone.
func (l *ipLimiter) perUserMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := clientIP(r)
		if uid, ok := userIDFrom(r.Context()); ok && uid != "" {
			key = "u:" + uid
		}
		if !l.allow(key, time.Now()) {
			w.Header().Set("Retry-After", "60")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

