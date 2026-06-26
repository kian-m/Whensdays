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

This branch builds **get-togethers**, a minimal scheduling assistant, on the template. Each app in this repo is its own branch; `main` keeps the clean template plus a `gallery/` catalog (one entry + home-page screenshot per app).

- **Schema:** `apps/api/db/migrations/0002_scheduler.sql` — `profiles`, `availability_slots`, `friendships`, `events`, `event_time_options`, `event_time_votes`, `event_attendees`, `event_preference_answers`.
- **API:** handlers in `apps/api/scheduler.go` (wired in `main.go`): profile, availability, events (create/list/get/rsvp/votes/preferences/finalize), friends (request/accept/availability). Every read/write is scoped to `userIDFrom(ctx)`; invite access is capability-based (link = the event id), host-only actions gated to `host_id`.
- **Web:** `react-router-dom` app — pages in `apps/web/src/pages`, shared types/contexts in `lib.tsx`, theme in `styles.css`, preference questions per event type in `apps/web/src/scheduler/questions.ts`.
- **Tests:** `e2e/tests/scheduler.spec.ts` (behavior + visual baseline). The Notes UI was replaced by the scheduler; `/api/notes` stays only so the E2E stack's readiness check passes.

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
- **Containers.** Each app has a multi-stage Dockerfile: build in a full image, ship a minimal one (`scratch` for api as non-root `65534`, `nginx:alpine` for web). This is what makes hosting cheap and the attack surface small.

## The non-negotiable workflow: a feature = code + a visual E2E test

For every feature:

1. Implement it (web and/or api).
2. Add/extend a Playwright spec in `e2e/tests/` that asserts **behavior** (`expect(...).toHaveText`, etc.) **and** a screenshot (`expect(page).toHaveScreenshot(...)`).
3. `make e2e` locally. New baselines are generated on first run — commit the `*-snapshots/` PNGs.
4. CI re-runs the suite; a visual diff fails the build.

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

## Conventions

- Go: tabs, stdlib-first, table-driven tests next to code as `*_test.go`. Prefer adding a dependency only when it clearly beats stdlib on security/speed.
- TS/React: strict mode on; 2-space indent; no API base URLs in components — always relative `/api/...`.
- Secrets: `.env` (gitignored) from `.env.example`. Never commit real values.
- Decisions get recorded in this file's stack table as they're made.
- **Docs stay in sync with code.** On every change, review `README.md` and update it in the *same commit* when a user-facing feature, route, port, env var, run command, or the architecture changes. The `README.md` "Features" table is the manual-navigation guide — keep it accurate. CI's `docs` job flags PRs that touch `apps/**` without updating `README.md`/`CLAUDE.md` (escape hatch: `[skip-docs]` in the PR title).
- **Feature screenshots are generated, never hand-edited.** After any UI change, run `make docs-shots` to recapture every feature into `docs/screenshots/` and commit the PNGs. Add a capture in `e2e/tests/screenshots.spec.ts` for each new feature/page. CI's `screenshots` job regenerates them and fails if the committed images are stale.
- **Each containerized stack has its own compose project name** (`name:` field): `clsandbox-demo`, `clsandbox-e2e`, `clsandbox-docs`, `clsandbox` (prod). Keep them distinct so stacks don't share databases/containers.
