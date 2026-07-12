// Package main is the clSandbox API: a minimal-dependency HTTP service built on
// the Go 1.22+ stdlib router, backed by Postgres via pgx + sqlc-generated
// queries, with authentication handled by Clerk.
package main

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // embed the IANA tz database (distroless image ships none)

	"github.com/clerk/clerk-sdk-go/v2"
	clerkhttp "github.com/clerk/clerk-sdk-go/v2/http"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver for migrations
	"github.com/pressly/goose/v3"

	"github.com/clsandbox/api/internal/analytics"
	"github.com/clsandbox/api/internal/db"
	"github.com/clsandbox/api/internal/notify"
)

//go:embed db/migrations/*.sql
var migrationsFS embed.FS

type ctxKey string

const userIDKey ctxKey = "userID"

type server struct {
	queries   *db.Queries
	pool      *pgxpool.Pool
	logger    *slog.Logger
	analytics *analytics.Client
	calendar  calendarConfig
	guests    guestSigner
	notify    *notify.Client
	appOrigin string
	klipyKey  string
	klipyStub bool
	geoStub   bool
	alerts    *alerter
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dbURL := mustEnv("DATABASE_URL")

	// Optionally apply migrations on boot (used by containers/CI for a
	// self-contained stack). Off by default.
	if os.Getenv("RUN_MIGRATIONS") == "true" {
		if err := runMigrations(dbURL); err != nil {
			logger.Error("migrations", "err", err)
			os.Exit(1)
		}
		logger.Info("migrations applied")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		logger.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	an := analytics.New(analytics.Config{
		APIKey:         os.Getenv("POSTHOG_API_KEY"),
		Host:           envOr("POSTHOG_HOST", "https://us.i.posthog.com"),
		PersonalAPIKey: os.Getenv("POSTHOG_PERSONAL_API_KEY"),
		Env:            envOr("APP_ENV", "development"),
		Release:        os.Getenv("APP_VERSION"),
	}, logger)
	defer an.Close()

	s := &server{
		queries: db.New(pool), pool: pool, logger: logger, analytics: an,
		calendar:  loadCalendarConfig(logger),
		guests:    newGuestSigner(logger),
		notify:    notify.New(os.Getenv("EMAIL_API_KEY"), os.Getenv("EMAIL_FROM"), logger),
		alerts:    newAlerter(),
		appOrigin: strings.TrimRight(os.Getenv("APP_ORIGIN"), "/"),
		klipyKey:  os.Getenv("KLIPY_API_KEY"),
		klipyStub: os.Getenv("KLIPY_MODE") == "stub",
		geoStub:   os.Getenv("GEO_MODE") == "stub",
	}
	// Email volume telemetry: every send becomes a PostHog event so the daily
	// digest can show usage against the provider's free tier.
	s.notify.OnSend = func(n int) { s.analytics.CaptureServer("email_sent", map[string]any{"recipients": n}) }
	auth := s.authMiddleware()

	// Per-IP rate limiters for the unauthenticated attack surface. Writes (guest
	// join → DB row) are strict; public reads (unfurls, image compositing) are
	// looser but still bounded so a scraper can't exhaust CPU/DB. Authenticated
	// routes rely on Clerk + per-user scoping and are not IP-limited here.
	// Disabled under AUTH_MODE=dev so hermetic E2E (all from one runner IP)
	// stays deterministic - mirrors the CALENDAR/KLIPY/GEO stub pattern.
	writeLimit := func(h http.Handler) http.Handler { return h }
	readLimit := func(h http.Handler) http.Handler { return h }
	proxyLimit := func(h http.Handler) http.Handler { return h }
	if os.Getenv("AUTH_MODE") != "dev" {
		writeLimit = newIPLimiter(30, 15).middleware  // ~30/min, burst 15
		readLimit = newIPLimiter(300, 100).middleware // ~300/min, burst 100
		// Outbound proxies (Klipy/Photon): per-USER cap protects upstream
		// free-tier quotas from a single actor. ~40/min covers debounced
		// typeahead + GIF search; abuse hits 429 well before the quota.
		proxyLimit = newIPLimiter(40, 20).perUserMiddleware
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	// Unauthenticated by design: the event id is the capability (invite link).
	mux.Handle("POST /api/csp-report", readLimit(http.HandlerFunc(s.handleCSPReport))) // browser CSP beacon
	mux.Handle("POST /api/guest/join", writeLimit(http.HandlerFunc(s.handleGuestJoin)))
	mux.Handle("POST /api/guest/merge", auth(http.HandlerFunc(s.handleGuestMerge)))
	// Full-page loads of /e/{id} are proxied here by nginx for link unfurls.
	mux.Handle("GET /e/{id}", readLimit(http.HandlerFunc(s.handleOGPage)))
	// Public browse (read-only, publishes only host-chosen fields) + cron.
	mux.Handle("GET /api/discover", readLimit(http.HandlerFunc(s.handleDiscover)))
	mux.HandleFunc("POST /api/cron/reminders", s.handleCronReminders)
	mux.HandleFunc("POST /api/cron/analytics", s.handleCronAnalytics) // CRON_KEY-gated daily digest
	// Follows + personal feed.
	mux.Handle("GET /api/feed", auth(http.HandlerFunc(s.handleFeed)))
	mux.Handle("GET /api/event-types", auth(http.HandlerFunc(s.handleListCustomTypes)))
	mux.Handle("DELETE /api/event-types/{label}", auth(http.HandlerFunc(s.handleDeleteCustomType)))
	mux.Handle("GET /api/badges", auth(http.HandlerFunc(s.handleBadges)))
	mux.Handle("POST /api/events/{id}/invites", auth(http.HandlerFunc(s.handleInviteFriend)))
	mux.Handle("GET /api/discover/mine", auth(http.HandlerFunc(s.handleDiscoverMine)))
	mux.Handle("POST /api/follows", auth(http.HandlerFunc(s.handleAddFollow)))
	mux.Handle("DELETE /api/follows/{kind}/{value}", auth(http.HandlerFunc(s.handleRemoveFollow)))
	mux.Handle("GET /api/notes", auth(http.HandlerFunc(s.handleListNotes)))
	mux.Handle("POST /api/notes", auth(http.HandlerFunc(s.handleCreateNote)))

	// Scheduler ("Whensdays") feature - see scheduler.go.
	mux.Handle("GET /api/profile", auth(http.HandlerFunc(s.handleGetProfile)))
	mux.Handle("PUT /api/profile", auth(http.HandlerFunc(s.handleUpsertProfile)))
	mux.Handle("PUT /api/profile/avatar", auth(http.HandlerFunc(s.handleSetAvatar)))
	mux.Handle("PUT /api/profile/email", auth(http.HandlerFunc(s.handleSetProfileEmail)))
	mux.Handle("GET /api/availability", auth(http.HandlerFunc(s.handleGetAvailability)))
	mux.Handle("PUT /api/availability", auth(http.HandlerFunc(s.handlePutAvailability)))
	mux.Handle("GET /api/availability/days", auth(http.HandlerFunc(s.handleGetAvailabilityDays)))
	mux.Handle("PUT /api/availability/days", auth(http.HandlerFunc(s.handlePutAvailabilityDays)))
	mux.Handle("GET /api/events", auth(http.HandlerFunc(s.handleListEvents)))
	mux.Handle("POST /api/events", auth(http.HandlerFunc(s.handleCreateEvent)))
	mux.Handle("GET /api/events/{id}", auth(http.HandlerFunc(s.handleGetEvent)))
	mux.Handle("POST /api/events/{id}/rsvp", auth(http.HandlerFunc(s.handleRsvp)))
	mux.Handle("POST /api/events/{id}/votes", auth(http.HandlerFunc(s.handleVotes)))
	mux.Handle("POST /api/events/{id}/general-votes", auth(http.HandlerFunc(s.handleGeneralVotes)))
	mux.Handle("POST /api/events/{id}/preferences", auth(http.HandlerFunc(s.handlePreferences)))
	mux.Handle("POST /api/events/{id}/finalize", auth(http.HandlerFunc(s.handleFinalize)))
	mux.Handle("PUT /api/events/{id}", auth(http.HandlerFunc(s.handleUpdateEvent)))
	mux.Handle("GET /api/gifs/search", auth(proxyLimit(http.HandlerFunc(s.handleGifSearch))))
	mux.Handle("GET /api/geo/search", auth(proxyLimit(http.HandlerFunc(s.handleGeoSearch))))
	mux.Handle("DELETE /api/events/{id}", auth(http.HandlerFunc(s.handleCancelEvent)))
	mux.Handle("DELETE /api/groups/{id}", auth(http.HandlerFunc(s.handleDeleteGroup)))
	mux.Handle("DELETE /api/friends/{id}", auth(http.HandlerFunc(s.handleDeleteFriendship)))
	// Comments + cohosts (see comments.go).
	mux.Handle("POST /api/events/{id}/comments", auth(http.HandlerFunc(s.handlePostComment)))
	mux.Handle("DELETE /api/events/{id}/comments/{commentId}", auth(http.HandlerFunc(s.handleDeleteComment)))
	mux.Handle("PUT /api/events/{id}/comments-enabled", auth(http.HandlerFunc(s.handleSetCommentsEnabled)))
	mux.Handle("POST /api/events/{id}/cohosts", auth(http.HandlerFunc(s.handleAddCohost)))
	mux.Handle("DELETE /api/events/{id}/cohosts/{userId}", auth(http.HandlerFunc(s.handleRemoveCohost)))
	// Notification mute: signed-in toggle + the one-click email link (the latter
	// is UNauthenticated - identity rides in a signed token; see mute.go).
	mux.Handle("POST /api/events/{id}/mute", auth(http.HandlerFunc(s.handleMuteToggle)))
	mux.Handle("GET /api/events/{id}/unsubscribe", readLimit(http.HandlerFunc(s.handleUnsubscribe)))
	// One-tap RSVP from email (UNauthenticated - signed token; see engage.go)
	// and the host's nudge-non-responders lever.
	mux.Handle("GET /api/events/{id}/rsvp-link", readLimit(http.HandlerFunc(s.handleEmailRsvp)))
	mux.Handle("POST /api/events/{id}/draft", auth(http.HandlerFunc(s.handleSetDraft)))
	mux.Handle("POST /api/events/{id}/nudge", auth(http.HandlerFunc(s.handleNudge)))
	// Public on purpose: the event id IS the invite capability (same fields the
	// OG unfurl already serves), and a bare <a href> can't attach a bearer -
	// this is what lets iOS open the invite directly in Calendar.
	mux.Handle("GET /api/events/{id}/calendar.ics", readLimit(http.HandlerFunc(s.handleEventICS)))
	// Personal live calendar feed: subscribe once, every event flows in.
	// Unauthenticated (calendar apps poll bare) - identity rides an HMAC token.
	mux.Handle("GET /api/feed.ics", readLimit(http.HandlerFunc(s.handleICSFeed)))
	mux.Handle("GET /api/calendar/feed-url", auth(http.HandlerFunc(s.handleFeedURL)))
	// Unauthenticated for the same reason: og:image is fetched by link
	// scrapers (iMessage, Slack, …) that can't send a bearer.
	mux.Handle("GET /api/events/{id}/og.png", readLimit(http.HandlerFunc(s.handleEventOGImage)))

	// Calendar import (see calendars_import.go). The Google OAuth callback is
	// intentionally UNauthenticated - Google redirects the browser to it with no
	// bearer; identity rides in the signed `state`.
	mux.Handle("GET /api/calendar/connections", auth(http.HandlerFunc(s.handleListCalendarConnections)))
	mux.Handle("GET /api/calendar/events", auth(http.HandlerFunc(s.handleCalendarEvents)))
	mux.Handle("GET /api/calendar/google/connect", auth(http.HandlerFunc(s.handleGoogleConnect)))
	mux.Handle("POST /api/calendar/apple-caldav", auth(http.HandlerFunc(s.handleAppleCalDAVConnect)))
	mux.HandleFunc("GET /api/calendar/google/callback", s.handleGoogleCallback)
	mux.Handle("POST /api/calendar/apple", auth(http.HandlerFunc(s.handleAppleConnect)))
	mux.Handle("DELETE /api/calendar/connections/{provider}", auth(http.HandlerFunc(s.handleDisconnectCalendar)))
	// Groups (see groups.go) - the recurring-circle wedge.
	mux.Handle("POST /api/groups", auth(http.HandlerFunc(s.handleCreateGroup)))
	mux.Handle("GET /api/groups", auth(http.HandlerFunc(s.handleListGroups)))
	mux.Handle("GET /api/groups/{id}", auth(http.HandlerFunc(s.handleGetGroup)))
	mux.Handle("POST /api/groups/{id}/members", auth(http.HandlerFunc(s.handleAddGroupMember)))
	mux.Handle("GET /api/groups/{id}/preview", auth(http.HandlerFunc(s.handleGroupPreview)))
	mux.Handle("POST /api/groups/{id}/join", auth(http.HandlerFunc(s.handleJoinGroup)))
	mux.Handle("PUT /api/groups/{id}", auth(http.HandlerFunc(s.handleUpdateGroup)))
	mux.Handle("PUT /api/groups/{id}/icon", auth(http.HandlerFunc(s.handleSetGroupIcon)))
	mux.Handle("DELETE /api/groups/{id}/members/{userId}", auth(http.HandlerFunc(s.handleRemoveGroupMember)))
	mux.Handle("PUT /api/groups/{id}/members/{userId}/role", auth(http.HandlerFunc(s.handleSetGroupMemberRole)))
	mux.Handle("GET /api/friends", auth(http.HandlerFunc(s.handleListFriends)))
	mux.Handle("POST /api/friends", auth(http.HandlerFunc(s.handleAddFriend)))
	mux.Handle("POST /api/friends/{id}/accept", auth(http.HandlerFunc(s.handleAcceptFriend)))
	mux.Handle("GET /api/friends/{id}/availability", auth(http.HandlerFunc(s.handleFriendAvailability)))

	// Server-side feature flags evaluated for the current user (see analytics).
	mux.Handle("GET /api/flags", auth(http.HandlerFunc(s.handleFlags)))

	port := envOr("API_PORT", "8080")
	// Activity emails (comments/RSVPs) are digested: the flusher drains the
	// notification queue every 5 minutes and sends one email per host instead of
	// per action. No-ops when email is disabled. min-instances=1 keeps it alive;
	// the drain is atomic so a second instance can't double-send.
	go s.startNotificationFlusher(context.Background())

	srv := &http.Server{
		Addr: ":" + port,
		// telemetry (innermost) captures per-request metrics to PostHog.
		Handler:           securityHeaders(requestLogger(logger, s.telemetry(mux))),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		logger.Info("api listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
	logger.Info("api stopped")
}

func runMigrations(dbURL string) error {
	sqlDB, err := sql.Open("pgx", dbURL)
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.Up(sqlDB, "db/migrations")
}

// --- auth ---

// authMiddleware returns the protection wrapper for /api routes. Default is
// Clerk (verifies the session JWT). AUTH_MODE=dev swaps in a stub that trusts an
// X-Dev-User header - for local/CI hermetic runs only, never production.
func (s *server) authMiddleware() func(http.Handler) http.Handler {
	var base func(http.Handler) http.Handler
	if os.Getenv("AUTH_MODE") == "dev" {
		s.logger.Warn("AUTH_MODE=dev: authentication is STUBBED - do not use in production")
		base = devAuth
	} else {
		// TrimSpace guards against a trailing newline in the secret (e.g. pasted
		// into `gcloud secrets create` with Enter): Go's http client rejects an
		// Authorization header containing "\n", so clerk-sdk-go's JWKS fetch fails
		// and EVERY token 401s. Trimming makes secret provisioning newline-safe.
		clerk.SetKey(strings.TrimSpace(mustEnv("CLERK_SECRET_KEY")))
		base = clerkAuth
	}
	// Guest tokens (see guests.go) are checked first in either mode:
	// "Authorization: Guest <token>" → a low-privilege guest user.
	return func(next http.Handler) http.Handler {
		wrapped := base(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Guest "); ok {
				uid, valid := s.guests.verify(tok)
				if !valid {
					writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid guest token"})
					return
				}
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, uid)))
				return
			}
			wrapped.ServeHTTP(w, r)
		})
	}
}

func devAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid := r.Header.Get("X-Dev-User")
		if uid == "" {
			uid = "demo-user"
		}
		ctx := context.WithValue(r.Context(), userIDKey, uid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func clerkAuth(next http.Handler) http.Handler {
	require := clerkhttp.RequireHeaderAuthorization()
	return require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := clerk.SessionClaimsFromContext(r.Context())
		if !ok || claims.Subject == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, claims.Subject)
		next.ServeHTTP(w, r.WithContext(ctx))
	}))
}

func userIDFrom(ctx context.Context) (string, bool) {
	uid, ok := ctx.Value(userIDKey).(string)
	return uid, ok && uid != ""
}

// --- handlers ---

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleListNotes(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	notes, err := s.queries.ListNotes(r.Context(), userID)
	if err != nil {
		s.logger.Error("list notes", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, notes)
}

func (s *server) handleCreateNote(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var in struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "body is required"})
		return
	}
	note, err := s.queries.CreateNote(r.Context(), db.CreateNoteParams{UserID: userID, Body: in.Body})
	if err != nil {
		s.logger.Error("create note", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusCreated, note)
}

// --- helpers & middleware ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		// API returns JSON/images only; lock scripts to none as defense-in-depth.
		h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data: https://static.klipy.com; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func requestLogger(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request", "method", r.Method, "path", r.URL.Path, "dur_ms", time.Since(start).Milliseconds())
	})
}

// statusRecorder captures the response status for telemetry.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// telemetry sends one PostHog event per request (method, matched route, status,
// duration) as an operational signal - the raw material for latency/error-rate
// dashboards and anomaly alerts. It wraps the mux so it sees the final status and
// can resolve the low-cardinality route pattern. No-op when analytics is off.
func (s *server) telemetry(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.analytics.Enabled() {
			mux.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		mux.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" {
			return // skip health-check noise
		}
		_, route := mux.Handler(r) // matched pattern, e.g. "GET /api/events/{id}"
		s.analytics.CaptureServer("api_request", map[string]any{
			"method":       r.Method,
			"route":        route,
			"path":         r.URL.Path,
			"status":       rec.status,
			"status_class": fmt.Sprintf("%dxx", rec.status/100),
			"ok":           rec.status < 400,
			"duration_ms":  time.Since(start).Milliseconds(),
		})
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("missing required env var", "key", key)
		os.Exit(1)
	}
	return v
}
