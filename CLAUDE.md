# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What clSandbox is

A clean, modern, full-stack monorepo built to be **secure, fast, scalable, and cheap to host**. It is a reusable sandbox: a React front end and a Go API, containerized end to end, where **every feature ships with a visual end-to-end test**.

Priorities, in order, that drive every decision here: **security → speed → scalability → hosting cost.**

## Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite | Fast builds/HMR, you read it easily, static output is trivial to host |
| Backend | Go (stdlib `net/http`, 1.22+ router) | Minimal deps = small attack surface; lowest latency/memory; tiny `scratch` image |
| Database | Postgres — **Neon** (serverless) in prod, local container in dev | $0 idle, autoscale, per-PR branching; standard SQL |
| Data access | `sqlc` + `pgx` (migrations via `goose`) | Type-safe Go generated from plain SQL; injection-safe, no ORM overhead |
| Monorepo | pnpm workspaces (JS) + Go modules, orchestrated by `make` | One entrypoint over a polyglot repo |
| Containers | Docker, multi-stage; `scratch` (api) + `nginx` (web) | Smallest, safest images; cheapest to run |
| Visual E2E | Playwright (`toHaveScreenshot`) | Behavior **and** pixel baseline per feature |
| CI | GitHub Actions | api / web / e2e jobs (e2e spins up Postgres + migrates) |
| Auth | **Clerk** (managed) | JWT verified in Go (`clerkhttp`); React via `@clerk/clerk-react`. Lowest auth-bug risk; free at sandbox scale |
| Hosting | API → **Cloud Run**, web → **Cloudflare Pages**, DB → **Neon** | All scale-to-zero / serverless: ~$0 idle, managed security, autoscale. See `docs/DEPLOY.md` |

**Prod data flow:** browser → Cloudflare Pages (static React) → `/api/*` proxied via Pages `_redirects` → Cloud Run (Go) → Neon. Single origin, no CORS. Deploy runs on green `main` (`.github/workflows/deploy.yml`); GCP auth is keyless (Workload Identity Federation), secrets (DB URL, Clerk) via Secret Manager.

All six foundational decisions are made; extend the app feature by feature from here.

## This branch: the scheduler app (`app/scheduler`)

This branch builds **Whensdays** (formerly "get-togethers"), a minimal scheduling assistant, on the template. Each app in this repo is its own branch; `main` keeps the clean template plus a `gallery/` catalog (one entry + home-page screenshot per app).

**Product direction (see README "Product direction"):** the wedge is recurring small friend groups/clubs, not one-off parties or work polls. The original growth-loop priorities (frictionless guests, email, calendar moat, recurring groups, intent monetization) and the discovery/onboarding phases are **shipped** — the roadmap now reads: **Now** = real deploy (Cloud Run/Pages/Neon + live Clerk + production Klipy key) and seeding the first real groups (initial audience: improv/stand-up/theater locals); **Next** = guest→account merge, ranking poll times against all attendees' availability, series editing, Discover moderation basics; **Later** = organizer premium (never paywall basics), deeper intent links, live `.ics` feeds. Feature breadth stays deprioritized; instrument the funnel (activation, invite→participant, K-factor, W4 retention) in the existing PostHog wiring before adding surface area. Watch costs: Clerk MAU (mitigated by guest flow), Klipy test-key rate limit (100/hr), calendar-data trust/scope minimalism.

- **Schema:** `apps/api/db/migrations/0002_scheduler.sql` — `profiles`, `availability_slots`, `friendships`, `events`, `event_time_options`, `event_time_votes`, `event_attendees`, `event_preference_answers`; later migrations add date-based availability, `calendar_connections` (`0008`), and `event_comments` + `event_cohosts` + `events.comments_enabled` (`0009`).
- **API:** handlers in `apps/api/scheduler.go` (wired in `main.go`): profile, availability (weekly `/api/availability` + paginated date-based `/api/availability/days`), events (create/list/get/rsvp/votes/preferences/finalize/edit), friends (request/accept/availability). Comments + cohosts live in `comments.go`; calendar import/export in `calendars.go` (.ics export) + `calendars_import.go` (Google OAuth + Apple iCal URL). Every read/write is scoped to `userIDFrom(ctx)`; invite access is capability-based (link = the event id). Event management is role-based via `eventAndRole` → host / cohost / guest (`isManager` = host or cohost); host-only actions (toggle comments, manage cohosts) gated to `host_id`. **Exceptions:** `GET /api/calendar/google/callback` is intentionally unauthenticated (Google redirects the browser with no bearer) — identity rides in an HMAC-signed `state`; `GET /api/events/{id}/calendar.ics` is also unauthenticated (event id = invite capability, same fields as the OG unfurl) and served `inline` with the invite URL in `URL:`/`DESCRIPTION` so iPhones open it straight in Calendar.
- **Web:** `react-router-dom` app — pages in `apps/web/src/pages` (incl. `Calendars.tsx`), shared types/contexts in `lib.tsx`, theme in `styles.css`, preference questions per event type in `apps/web/src/scheduler/questions.ts`.
- **Calendar feature:** export = RFC 5545 `.ics` (stdlib, 2h default duration) + a client-built "Add to Google Calendar" link. Import = Google OAuth (`calendar.readonly`, tokens AES-256-GCM encrypted at rest) + Apple published `.ics`/`webcal` URL (SSRF-guarded fetch); display-only. `CALENDAR_MODE=stub` mirrors `AUTH_MODE=dev` — it bypasses real providers and seeds fixed events for hermetic E2E/docs. Env: `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `APP_ORIGIN`, `CALENDAR_TOKEN_KEY`.
- **Growth loop (implemented):** no-account guests (`guests.go`: `POST /api/guest/join` unauthenticated, HMAC guest tokens checked first in `authMiddleware`; guests are real low-privilege users), transactional email (`internal/notify`, Resend-compatible, no-op unless `EMAIL_API_KEY`/`EMAIL_FROM`; triggers in `notifications.go`), groups (`groups.go` + migration `0011`, member-gated), imported-calendar busy overlays + poll ranking (client-side, `importedBusy` in `lib.tsx`), intent links (dinner→OpenTable, trip→Booking). `profiles.email` (`0010`) is optional and drives email. Recurring events (`0012`): fixed-time events accept `repeat`/`repeat_count`, occurrences pre-materialized as events sharing `series_id` (no cron; per-occurrence RSVPs). Group icons (`0013`): emoji validated server-side (`validEmoji` in groups.go — never free text) or an uploaded photo via `PUT /api/groups/{id}/icon`. Reminders (`0014`) + public discovery (`0015`) live in `discover.go`: `POST /api/cron/reminders` (CRON_KEY-gated, idempotent), `GET /api/discover` (**unauthenticated read-only** browse of host-published fields), follows (host/topic) + `GET /api/feed`; events carry `visibility` (private/friends/public, `0016`) + `topic`/`city`; topics are a FIXED category set (`categories` in ranking.go, mirrored as `CATEGORIES` in lib.tsx — update both together); the Discover chips are dynamic (`ListActiveTopics` rides in `GET /api/discover` — only categories with an upcoming public event render). Preset event types incl. show/practice/openmic (`0021`; validation in handleCreateEvent + `EVENT_TYPES`/`QUESTIONS` in questions.ts — update together); saved custom types are deletable (`DELETE /api/event-types/{label}`). City input = curated `CITIES` datalist + timezone prefill (`guessCity`), deliberately no external geo API. `GET /api/feed?scope=public|friends` is ranked by the pure scorer in `ranking.go` (weights documented there; unit-tested). Discover renders signed-out too (public shell in App.tsx). Event covers + themes (`0022`): hero card edits **in place** (`HeroCard` in EventPage.tsx — title/details/visibility plus a square cover: uploaded data-URL via `fileToAvatar(420)` or a Klipy CDN gif, validated by `validCoverURL` in gifs.go — data:image/ or static.klipy.com only; `theme` from the fixed `eventThemes` list renders as `.event-theme.theme-*` fixed CSS tints). Klipy proxy: `GET /api/gifs/search` (authed; `KLIPY_API_KEY` env server-side only — never in the repo or browser; empty q = capability probe; unset key ⇒ `enabled:false` and the web hides the picker; `KLIPY_MODE=stub` serves fixed `/gif-stub/` results for hermetic E2E/docs). Comments accept a `gif_url` (`0023`, Klipy CDN/stub only — `validGifURL`); the shared `GifPicker`/`EventThumb` live in ui.tsx, and a cover renders as the tile's main visual on Home/Discover/Groups (`photo_url` rides in the discover/feed selects). The api image copies the CA bundle into scratch — without it ALL outbound TLS (Klipy/Google/Resend) fails x509. Deletion (`deletion.go`): events soft-cancel (`status='cancelled'`, host-only, `?series=all`, attendees emailed; finalize guards against resurrecting), groups hard-delete (owner; events keep, `group_id` nulls), friendships hard-delete by row id (either party — decline/cancel/unfriend). `ListFriends` returns the friendship `id` for this. `GET /api/friends` also returns `suggestions` (`ListPeopleYouMayKnow`): people you've co-attended events with, scored by event visibility × both-going (public=weakest, friends/invite-only both-going=strongest), excluding existing friends/requests/guests. Availability editing on Profile is an explicit Edit→Save flow (read-only DayGrid until Edit); saves surface via a `Toast` (ui.tsx). The DayGrid is **tri-state** — **green (`--go`) = free, red (`--no`) = busy, blank = unselected**; each availability row carries a `status` (`free`|`busy`, migration `0019`), imported-calendar busy is a separate `locked` set (hatched, disabled). An `AvailLegend` (ui.tsx) key sits under every grid (Profile + Friends). General polls are **scoped** (`events.general_scope`, migration `0020`): `week` → concrete dates × dayparts (vote dimension `dayslot`, "YYYY-MM-DD:daypart"), `month` → date picks (`day`), `general` → months + weekday grid (`month`/`slot`, the original); answer windows anchor at the event's `created_at` (`daysFromDate` in lib.tsx) so every attendee sees the same dates, and the server validates picks against that window. Quick defaults to `week`, the wizard to `general`. A `paintMode` Free/Busy brush decides which state a cell tap or header-fill paints (`free`/`busy` sets kept disjoint); tapping a cell that's already the brush color clears it to unselected. Full-page loaders use `loading && !data` so refetches don't remount/scroll-jump. Theme: **dark by default**, light via `<html data-theme="light">` (helpers `getTheme`/`applyTheme` in lib.tsx, no-flash script in index.html, toggle on Profile). Look = **glass over a drifting sky**, palette = **sunset through glass** (split-complementary: coral accent `#ee6c4d`/`#d3572f` + amber/teal against a teal-navy dusk or warm-horizon day sky; the logo `icon.svg` shares the exact palette — retint both together): pure-CSS animated background (`--sky`/`--cloud-*` on `body::before/::after`, honors `prefers-reduced-motion`) with frosted panels (`--glass*` tokens + `backdrop-filter` on `.card`/`.tabbar`/calendar) and square-ish radii (`--radius`/`--radius-sm`) — restyle via tokens in styles.css, never per-component; docs screenshots freeze animations (`animations: "disabled"`), E2E `toHaveScreenshot` freezes them by default. Home has a filter row (all/upcoming/hosting/attending). OG unfurls (`ogpage.go`) serve a branded `og-card.png` (regenerate with `make og-card`). Secret scanning: gitleaks CI job + `make scan-secrets`/`install-hooks` (`.gitleaks.toml`). **Phase 3 growth-loop:** `POST /api/guest/join` also works WITHOUT an event_id (landing-page "Start a plan" → guest hosts via `/start`→`/quick`); profile handles are optional (server `slugify` + collision suffix); `/e/{id}` full-page loads are nginx-proxied to `handleOGPage` (ogpage.go) which serves Open Graph tags and bounces browsers to the SPA alias `/ev/{id}` — keep both routes + the `/ev/` guest-path checks in App.tsx. Web Share API button on the invite card; PWA manifest + the real logo in `apps/web/public/` — `icon.svg` (cleaned trace: transparent, no black bg/white halos) is the favicon, PWA icon, and the W of the brand lockup (`.brand .dot`); `hensdays.svg` is the cursive wordmark right after it (single-path mask asset — painted via CSS `mask` + `var(--ink)` so it's black in light / white in dark; never hardcode its color), and rides the OG card (`make og-card` inlines it); `apple-touch-icon.png` covers iOS bookmarks (PNG on dark bg — iOS renders SVG/transparency black); routes are code-split via React.lazy (landing/dashboard eager, rest on demand). The dashboard (`/api/events`) also returns `faces` — a per-event avatar-stack preview (`ListGoingFaces`: ≤6 going attendees, viewer-prioritized friends → has-photo → initials, plus total) rendered as an overlapping facepile on Home tiles (friends get an accent ring); the guest banner always offers a **Sign up** CTA (Clerk modal in prod, simulated conversion in dev). The dashboard unions hosting + **cohosting** (cohosts see events without opening the invite link; `ListEventsAttending` excludes cohosted rows to avoid duplicates), and all event writes (rsvp/votes/general-votes/preferences) go through `requireActiveEvent` — 409 on cancelled events.
- **Tests:** `e2e/tests/scheduler.spec.ts` (incl. the `.ics`/Google export) and `e2e/tests/calendars.spec.ts` (import, stub mode) — behavior + visual baselines. The Notes UI was replaced by the scheduler; `/api/notes` stays only so the E2E stack's readiness check passes.

## Layout

```
clSandbox/
  apps/
    web/        React + Vite. App in src/. Proxies /api -> api in dev (vite.config.ts) and prod (nginx.conf)
    api/        Go service. main.go + *_test.go
      db/migrations/   goose SQL migrations (source of truth for schema)
      db/query/        SQL for sqlc to generate from
      internal/db/     sqlc-GENERATED Go — do not hand-edit; run `make generate`
      sqlc.yaml        codegen config
  e2e/          Playwright. One spec per feature; baselines committed as *-snapshots/
  compose.yaml  Full containerized stack (web + api + db)
  Makefile      All commands route through here
  .github/workflows/ci.yml
```

## Commands

Run everything through the **Makefile** (`make help` lists targets):

- `make install` — pnpm deps + go modules + Playwright browser
- `make dev` — api (`go run`) + web (Vite) with hot reload
- `make build` — web bundle + stripped static api binary
- `make test` — Go unit tests + web typecheck
- `make e2e` — Playwright visual tests
- `make e2e-update` — refresh visual baselines (**review the diff before committing**)
- `make up` / `make down` — build & run / stop the full container stack
- `make fmt` / `make lint` — `go fmt` / `go vet`
- `make db-up` / `make db-down` — start/stop local Postgres container
- `make migrate` / `make migrate-down` — apply / roll back DB migrations (goose)
- `make generate` — regenerate `internal/db` from SQL after editing `db/query` or `db/migrations`

Typical local first run:

```bash
cp .env.example .env  # then fill DATABASE_URL + Clerk keys
make install          # deps + go.sum (go mod tidy) + Playwright browser
make db-up            # local Postgres
make migrate          # create schema
make dev              # api + web with hot reload
```

`make dev`/`make e2e` need the env vars in `.env` exported (e.g. `set -a; source .env; set +a`). The API requires `DATABASE_URL` and `CLERK_SECRET_KEY`; the web build/dev needs `VITE_CLERK_PUBLISHABLE_KEY`; E2E also needs `CLERK_PUBLISHABLE_KEY` + the `E2E_CLERK_USER_*` test user.

Run a single test:

```bash
cd apps/api && go test -run TestHandleHealth ./...      # one Go test
cd e2e && pnpm exec playwright test home.spec.ts        # one E2E spec
cd e2e && pnpm exec playwright test -g "renders the message"  # by title
```

Local toolchains: Node, pnpm, and Docker are present. **Go is not installed locally yet** — install it (`brew install go`) to use `make dev-api`/`make test`, or rely on Docker (`make up`) and CI, which provide Go.

## How the pieces fit

- **Single origin.** The browser only ever talks to the web origin; `/api/*` is reverse-proxied to the Go service — Vite proxy in dev, nginx in the container, Cloudflare Pages `_redirects` in prod. No CORS, no hardcoded API URLs.
- **Auth.** The React app wraps everything in `ClerkProvider`; protected UI sits inside `<SignedIn>`. Every API call attaches the Clerk session token (`Authorization: Bearer`). On the API, protected routes are wrapped with `clerkhttp.RequireHeaderAuthorization()`; handlers read the user id via `userIDFrom(ctx)` (the Clerk `sub`) and scope all queries to it. Never trust a user id from the request body — always from the verified token.
- **API design.** `apps/api/main.go` connects a `pgxpool`, builds `*db.Queries`, and wires routes on the stdlib mux with `securityHeaders` + `requestLogger` middleware and graceful shutdown. Handlers hang off `*server`, return JSON via `writeJSON`, and bound request bodies with `MaxBytesReader`. Keep dependencies minimal — `pgx` is the only direct one.
- **Data flow (the Notes feature is the reference example).** Define schema in `db/migrations/*.sql` → write SQL in `db/query/*.sql` → `make generate` produces type-safe Go in `internal/db` → call it from a handler. Never hand-write SQL strings in handlers or edit `internal/db` by hand.
- **Analytics.** PostHog is wired front and back (`apps/web/src/analytics.ts`, `apps/api/internal/analytics`). Both no-op when unconfigured (dev/E2E). Backend owns authoritative business events + automatic `api_request` telemetry; frontend owns autocapture, pageviews, masked replay, and intent events. Distinct id = the app user id on both sides. **See [`ANALYTICS.md`](ANALYTICS.md).**
- **Containers.** Each app has a multi-stage Dockerfile: build in a full image, ship a minimal one (`scratch` for api as non-root `65534`, `nginx:alpine` for web). This is what makes hosting cheap and the attack surface small.

## The non-negotiable workflow: a feature = code + a visual E2E test

For every feature:

1. Implement it (web and/or api).
2. **Instrument analytics** — capture the authoritative business event(s) in the API handler (`s.analytics.Capture`) and any UI/intent event on the web (`analytics.capture`, name in `EVENTS`). Both no-op when unconfigured. See the "Instrumenting a new feature" checklist in [`ANALYTICS.md`](ANALYTICS.md).
3. Add/extend a Playwright spec in `e2e/tests/` that asserts **behavior** (`expect(...).toHaveText`, etc.) **and** a screenshot (`expect(page).toHaveScreenshot(...)`).
4. `make e2e` locally. New baselines are generated on first run — commit the `*-snapshots/` PNGs.
5. CI re-runs the suite; a visual diff fails the build.

### Run the whole thing with only Docker (nothing else installed)

```bash
make e2e-docker
```

`compose.e2e.yaml` builds Postgres + API + web + a Playwright runner and executes the visual E2E against the real, prod-shaped stack (web nginx → API → Postgres). It uses **dev auth mode** so no Clerk account is needed:

- API: `AUTH_MODE=dev` swaps Clerk verification for a stub user (`demo-user`); `RUN_MIGRATIONS=true` self-applies migrations on boot. **Default is always Clerk — dev mode is opt-in and logs a warning.**
- Web: built with `VITE_AUTH_MODE=dev` → a Clerk-free bundle.
- E2E: `E2E_AUTH_MODE=dev` → the spec skips Clerk sign-in.

This is the same path CI runs. Visual baselines are generated on Linux (`*-chromium-linux.png`) so they match CI exactly; commit them.

### The reference spec

`e2e/tests/notes.spec.ts` is the reference spec: it creates a note (behavior) and snapshots the stable header+form region rather than the whole page, because the notes list grows across runs. **Keep visual baselines deterministic** — snapshot regions that don't depend on accumulated data, or reset/seed the DB in the test. Screenshots are pinned by config (`maxDiffPixelRatio: 0.01`, fixed Chromium). For an intentional UI change, run `make e2e-update`, eyeball the diff, then commit.

## Agent workflow: delegate cheap, verify smart (token economy)

For AI-assisted work in this repo, route by task type to maximize output per token:

- **Delegate to a lesser-model sub-agent** (Haiku/Sonnet) anything mechanical and well-specified: boilerplate handlers/pages that mirror an existing pattern, test scaffolding, docs sync, repetitive multi-file edits, migrations copied from a template. The delegating (stronger) model writes a tight spec first: exact files, the existing pattern to mirror (by path), and acceptance criteria.
- **Never delegate**: architecture/API-contract decisions, auth/permission/crypto code, cross-cutting refactors, anything where a subtle bug is expensive (this repo's security-first priority).
- **Verify cheaply, in this order** (stop at first failure): (1) machine gates — `make test`, typecheck, `go vet`, targeted E2E — these cost ~0 tokens; (2) **diff-only review** by the stronger model (`git diff` hunks, never re-reading whole files); (3) spot-check acceptance criteria only where the diff looks off.
- **One-retry rule**: if a sub-agent's output fails verification twice, the stronger model takes over directly — retry loops cost more than doing the work.

## Conventions

- Go: tabs, stdlib-first, table-driven tests next to code as `*_test.go`. Prefer adding a dependency only when it clearly beats stdlib on security/speed.
- TS/React: strict mode on; 2-space indent; no API base URLs in components — always relative `/api/...`.
- Secrets: `.env` (gitignored) from `.env.example`. Never commit real values.
- Decisions get recorded in this file's stack table as they're made.
- **Docs stay in sync with code.** On every change, review `README.md` and update it in the *same commit* when a user-facing feature, route, port, env var, run command, or the architecture changes. The `README.md` "Features" table is the manual-navigation guide — keep it accurate. CI's `docs` job flags PRs that touch `apps/**` without updating `README.md`/`CLAUDE.md` (escape hatch: `[skip-docs]` in the PR title).
- **Feature screenshots are generated, never hand-edited.** After any UI change, run `make docs-shots` to recapture every feature into `docs/screenshots/` and commit the PNGs. Add a capture in `e2e/tests/screenshots.spec.ts` for each new feature/page. CI's `screenshots` job regenerates them and fails if the committed images are stale.
- **Each containerized stack has its own compose project name** (`name:` field): `clsandbox-demo`, `clsandbox-e2e`, `clsandbox-docs`, `clsandbox` (prod). Keep them distinct so stacks don't share databases/containers.
