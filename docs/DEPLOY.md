# Deploy

API → **Google Cloud Run**. Web → **Cloudflare Pages**. DB → **Neon**.
CI/CD lives in `.github/workflows/deploy.yml` and runs on green `main`.

Architecture in prod: browser → Cloudflare Pages (static React) → `/api/*` + `/e/*` proxied via a Pages Function (CI-generated; `_redirects` only proxies GET) → Cloud Run (Go) → Neon (Postgres). Single origin, no CORS, scale-to-zero everywhere.

## One-time setup

### 1. Neon (database)
1. Create a project + database `clsandbox` at neon.tech.
2. Copy the pooled connection string (`...?sslmode=require`).

### 2. GCP (Cloud Run + Artifact Registry, keyless auth)
1. Create a project; set `GCP_PROJECT` / `GCP_REGION` in `deploy.yml`.
2. Enable Artifact Registry, Cloud Run, Secret Manager.
3. Create an Artifact Registry **docker** repo named `clsandbox` (matches `AR_REPO`).
4. Store the DB URL: `gcloud secrets create DATABASE_URL --data-file=-` (paste the Neon string). Grant the runtime service account `secretAccessor`.
5. Set up **Workload Identity Federation** for this GitHub repo (no JSON keys). Record the provider resource name and the service account email.

### 2b. Billing kill switch (recommended before first deploy)

GCP has no built-in hard spend cap. `scripts/billing-killswitch/` sets one up:
a $-budget publishes to Pub/Sub and a tiny function detaches billing from the
project when actual cost crosses it (Cloud Run goes offline; Neon/Cloudflare
are unaffected). Full commands + re-arm procedure in that directory's README.

### 3. Cloudflare Pages
1. Create a Pages project named `clsandbox` (matches `--project-name`).
2. Create an API token with Pages:Edit; note your account ID.

### 4. Clerk (auth)
1. Create a Clerk application; copy the publishable + secret keys.
2. Store the secret key in GCP Secret Manager: `gcloud secrets create CLERK_SECRET_KEY --data-file=-`.
3. Create a dedicated **test user** (email + password) for E2E.

### 5. PostHog (analytics)
1. Create a PostHog project; note the **project API key** (`phc_…`), a **personal API key** (`phx_…`, secret), and the numeric **project id**. Full guide: [`../ANALYTICS.md`](../ANALYTICS.md).
2. Store secrets for Cloud Run: `gcloud secrets create POSTHOG_API_KEY --data-file=-` and `gcloud secrets create POSTHOG_PERSONAL_API_KEY --data-file=-`. Grant the runtime SA `secretAccessor`.
3. Or manage all of the above in **Doppler** and use its **GCP Secret Manager** integration to populate those secrets (the source-of-truth path; see `ANALYTICS.md`).

### 5b. Calendar import (optional)
Enables the **Calendars** page to connect a user's Google/Apple calendar. Skip it and the feature simply shows "not configured" for Google; Apple iCal URLs still work without any setup. **Never set `CALENDAR_MODE=stub` in production** — it disables real providers.
1. **Google OAuth client:** Google Cloud Console → APIs & Services. Enable the **Google Calendar API**. Create an **OAuth 2.0 Client ID** (Web application) with authorized redirect URI `https://<your-origin>/api/calendar/google/callback`. The `calendar.readonly` scope is "sensitive": while unverified it works for **test users** you add (up to 100) — submit for verification before a public launch.
2. Generate the token-encryption key: `openssl rand -base64 32`.
3. Store secrets for Cloud Run and grant the runtime SA `secretAccessor`:
   `gcloud secrets create GOOGLE_OAUTH_CLIENT_ID --data-file=-`,
   `gcloud secrets create GOOGLE_OAUTH_CLIENT_SECRET --data-file=-`,
   `gcloud secrets create CALENDAR_TOKEN_KEY --data-file=-`.
4. Set `APP_ORIGIN` (e.g. `https://app.example.com`) as a plain env var on the Cloud Run service so the redirect URI and post-auth return URL resolve.

### 5c. Reminder emails (optional)
1. Set `EMAIL_API_KEY`/`EMAIL_FROM` (Resend-compatible) and a random `CRON_KEY` as Cloud Run secrets.
1. Optional: `KLIPY_API_KEY` (GIF covers/comments; get a production key from partner.klipy.com — the test key is rate-limited to 100 calls/hour). The picker hides when unset. Outbound TLS works because the api image ships the CA bundle into `scratch` — keep that Dockerfile line.
2. Create the Cloud Scheduler jobs (both `POST` with header `X-Cron-Key: <CRON_KEY>`, both idempotent):
   - `whensdays-reminders` → `https://<api>/api/cron/reminders` (daily 2pm PT) — day-before reminders, day-after recaps, poll-velocity, streak congrats, series-ended.
   - `whensdays-analytics` → `https://<api>/api/cron/analytics` (daily 8am PT) — the owner metrics digest.
   - **Set retries on both** (`--max-retry-attempts=3 --min-backoff=30s --max-backoff=300s --max-retry-duration=600s`). Cloud Scheduler defaults to **zero retries**, so a single transient Cloud Run 503 (e.g. the min-instance recycled mid-request) silently drops that run's emails with no second attempt. The handlers are idempotent (per-event `reminder_sent`/`event_recaps`/etc. flags), so a retry only re-sends what didn't go out.

### 6. GitHub repo secrets
| Secret | Value |
|---|---|
| `GCP_WIF_PROVIDER` | Workload Identity provider resource name |
| `GCP_SERVICE_ACCOUNT` | deployer service account email |
| `API_PUBLIC_URL` | Cloud Run service URL (e.g. `https://clsandbox-api-xxx.run.app`) |
| `APP_ORIGIN` | Public site origin (e.g. `https://whensdays.com`) — link unfurls, email links, calendar OAuth redirect |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (public; baked into web build + used by CI e2e) |
| `CLERK_SECRET_KEY` | Clerk secret key (CI e2e; also in Secret Manager for Cloud Run) |
| `E2E_CLERK_USER_USERNAME` / `E2E_CLERK_USER_PASSWORD` | the Clerk test user |
| `VITE_PUBLIC_POSTHOG_KEY` | PostHog project key (public; baked into web build) |
| `POSTHOG_PERSONAL_API_KEY` | PostHog personal key (secret; CI deploy annotations; also in Secret Manager) |
| `POSTHOG_PROJECT_ID` | PostHog numeric project id (for deploy annotations) |

> Repo **variables** (not secrets): `VITE_PUBLIC_POSTHOG_HOST` (e.g. `https://us.i.posthog.com`) and `VITE_PUBLIC_POSTHOG_RECORD` (`true`/`false`).

### 7. Secret scanning (already wired)

Secrets are guarded on two layers so a credential can't reach the remote:
- **CI**: the `secrets` job (`.github/workflows/ci.yml`) runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push/PR — a leak fails the build. Config: `.gitleaks.toml`.
- **Local (opt-in)**: `make install-hooks` enables a pre-commit hook that scans staged changes before they're committed.
- Ad-hoc full-history audit: `make scan-secrets`.

Real secrets live only in **GCP Secret Manager** (API) and **GitHub Actions secrets** (build/deploy) — never in the repo. `.env` is gitignored; `.env.example` holds placeholders only.

## Base secrets needed to boot

The deploy references these in `--set-secrets` out of the box (create each with `gcloud secrets create <NAME> --data-file=-`): `DATABASE_URL`, `CLERK_SECRET_KEY`, `POSTHOG_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `GUEST_TOKEN_KEY` (`openssl rand -base64 32` — signs no-account guest tokens). Optional feature secrets (calendar §5b, email §5c) are appended to that line when you enable them.

## Migrations in prod

Migrations are not auto-run on deploy. Apply them against Neon before/with a release:

```bash
DATABASE_URL="<neon-url>" make migrate
```

(Or add a Cloud Run Job / release step that runs `goose up` — kept manual here to avoid surprise schema changes on every push.)
