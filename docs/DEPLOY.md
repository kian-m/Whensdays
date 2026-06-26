# Deploy

API → **Google Cloud Run**. Web → **Cloudflare Pages**. DB → **Neon**.
CI/CD lives in `.github/workflows/deploy.yml` and runs on green `main`.

Architecture in prod: browser → Cloudflare Pages (static React) → `/api/*` proxied (Pages `_redirects`) → Cloud Run (Go) → Neon (Postgres). Single origin, no CORS, scale-to-zero everywhere.

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

### 6. GitHub repo secrets
| Secret | Value |
|---|---|
| `GCP_WIF_PROVIDER` | Workload Identity provider resource name |
| `GCP_SERVICE_ACCOUNT` | deployer service account email |
| `API_PUBLIC_URL` | Cloud Run service URL (e.g. `https://clsandbox-api-xxx.run.app`) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (public; baked into web build + used by CI e2e) |
| `CLERK_SECRET_KEY` | Clerk secret key (CI e2e; also in Secret Manager for Cloud Run) |
| `E2E_CLERK_USER_USERNAME` / `E2E_CLERK_USER_PASSWORD` | the Clerk test user |
| `VITE_PUBLIC_POSTHOG_KEY` | PostHog project key (public; baked into web build) |
| `POSTHOG_PERSONAL_API_KEY` | PostHog personal key (secret; CI deploy annotations; also in Secret Manager) |
| `POSTHOG_PROJECT_ID` | PostHog numeric project id (for deploy annotations) |

> Repo **variables** (not secrets): `VITE_PUBLIC_POSTHOG_HOST` (e.g. `https://us.i.posthog.com`) and `VITE_PUBLIC_POSTHOG_RECORD` (`true`/`false`).

## Migrations in prod

Migrations are not auto-run on deploy. Apply them against Neon before/with a release:

```bash
DATABASE_URL="<neon-url>" make migrate
```

(Or add a Cloud Run Job / release step that runs `goose up` — kept manual here to avoid surprise schema changes on every push.)
