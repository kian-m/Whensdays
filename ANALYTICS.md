# Analytics (PostHog)

This app is instrumented end to end with **PostHog** — frontend **and** backend —
so you can build metrics, funnels, and anomaly alerts. It's designed to be **safe
by default**: with no keys configured (local dev, hermetic E2E/CI) every analytics
call is a **no-op**, so nothing is sent and nothing breaks.

Frontend and backend both use the **same distinct id** — the app user id (the
Clerk `sub`, or `demo-user` in dev) — so a person's client and server events
stitch into one timeline in PostHog.

---

## 1. Keys & what's secret

| Key | What it is | Secret? | Used by | Where it lives |
|---|---|---|---|---|
| `VITE_PUBLIC_POSTHOG_KEY` | Project API key (`phc_…`) | **No** — public, shipped in the browser bundle (like the Clerk publishable key) | Web | `.env` (local), GH **secret** for the build step, baked into the static bundle |
| `POSTHOG_API_KEY` | **Same** project API key (`phc_…`) | No (write-only ingestion) — manage as config | API | `.env` (local), GCP Secret Manager → Cloud Run |
| `POSTHOG_HOST` / `VITE_PUBLIC_POSTHOG_HOST` | Ingestion host, e.g. `https://us.i.posthog.com` | No | API + Web | env / GH **vars** |
| `VITE_PUBLIC_POSTHOG_RECORD` | `true`/`false` — session replay on the web | No | Web | env / GH **vars** |
| `POSTHOG_PERSONAL_API_KEY` | Personal API key (`phx_…`) | **YES — secret** | API (feature-flag local eval) + CI (deploy annotations) | GCP Secret Manager / Doppler; **never** in the browser |
| `POSTHOG_PROJECT_ID` | Numeric project id | No (but pair it with the personal key) | CI annotations | GH **secret/var** |

> The project key (`phc_…`) is the same value for `VITE_PUBLIC_POSTHOG_KEY` and
> `POSTHOG_API_KEY`. It is **not** a real secret — it can only write events. The
> only true secret here is the **personal** key (`phx_…`), which can read/modify
> your PostHog project.

## 2. Get your keys

1. Create a project at [us.posthog.com](https://us.posthog.com) (or EU).
2. **Project API key** (`phc_…`): Settings → Project → "Project API Key".
3. **Personal API key** (`phx_…`): Settings → "Personal API keys" → create one
   scoped to *Feature flags: read* (+ *Annotations: write* if you want deploy
   markers). Treat it like a password.
4. **Project id**: Settings → Project → numeric id (for deploy annotations).
5. Enable **Session Replay** in Settings if you want recordings (we send them
   masked).

## 3. Secret management — Doppler

Doppler is the source of truth; it feeds local, CI, and prod.

- **Local:** put everything in a Doppler config (e.g. `clsandbox/dev`) and run via
  Doppler so the vars are injected without a committed `.env`:
  ```bash
  doppler run -- make dev
  doppler run -- docker compose -f compose.demo.yaml up --build
  ```
  (A plain gitignored `.env` also works — Doppler is just the team-friendly path.)
- **CI (GitHub Actions):** install the Doppler CLI step (`dopplerhq/secrets-fetch-action`
  or `doppler run`) using a **Doppler service token** stored as a GH secret, or use
  Doppler's GitHub integration to sync secrets into the repo's Actions secrets.
- **Prod (Cloud Run):** use Doppler's **GCP Secret Manager** integration to sync
  `POSTHOG_API_KEY` and `POSTHOG_PERSONAL_API_KEY` into Secret Manager. Cloud Run
  already reads them via `--set-secrets` in `deploy.yml` — no Doppler CLI is baked
  into the (scratch) image, keeping it minimal.

Secrets to load into Doppler: `DATABASE_URL`, `CLERK_SECRET_KEY`,
`POSTHOG_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, plus the
public `VITE_PUBLIC_POSTHOG_*` and `VITE_CLERK_PUBLISHABLE_KEY` values.

## 4. Run it locally with analytics ON

```bash
cp .env.example .env     # fill the POSTHOG_* values
set -a; source .env; set +a
docker compose -f compose.demo.yaml up --build   # demo passes POSTHOG_* through
```
Open http://localhost:8080, click around, then watch **Activity** in PostHog.
Leave the keys empty and analytics stays disabled (the API logs
`analytics disabled (no POSTHOG_API_KEY)`).

---

## 5. What's tracked

**Frontend** (`apps/web/src/analytics.ts`)
- **Autocapture** — clicks, inputs, form submits, element metadata.
- **Pageviews** — one `$pageview` per client-side route change (SPA).
- **Session replay** — on by default, **all text + inputs masked** (no PII).
- **Exceptions** — uncaught JS errors (`capture_exceptions`).
- **Intent events** the server can't see: `create_event_opened`,
  `preview_as_guest_toggled`, `share_link_copied`, `friend_availability_viewed`.
- **Identify** — on profile load: distinct id = app user id, with `handle`.

**Backend** (`apps/api/internal/analytics`)
- **Request telemetry** — one `api_request` per call with `method`, `route`
  (low-cardinality pattern), `status`, `status_class`, `ok`, `duration_ms`. Sent
  with `$process_person_profile=false` so ops data never bloats person profiles —
  ideal for latency/error-rate dashboards and alerts.
- **Authoritative business events** (reliable, ad-blocker-proof): `event_created`,
  `event_viewed`, `rsvp_submitted`, `poll_voted`, `preferences_submitted`,
  `event_finalized`, `friend_requested`, `friend_accepted`, `profile_updated`.
- **Identify** — person properties (`handle`, `name`) on profile update.

Every event also carries `service` (`api`/`web`), `environment`, and `release`.

## 6. Metrics & alerts

Build these in the PostHog UI on the data above:

- **API error rate** — Trends on `api_request` broken down by `status_class`;
  alert when `5xx` share exceeds a threshold.
- **Latency** — `api_request` with a P95 of `duration_ms` by `route`; alert on
  spikes.
- **Funnel** — `create_event_opened → event_created → rsvp_submitted` to spot drop-off.
- **Activation** — daily `profile_updated` / `event_created`; alert on a sudden drop.
- **Frontend errors** — Error tracking dashboard; alert on new/spiking exceptions.

PostHog **Alerts** live on an insight (⋯ → *Alerts*) and can notify via email or
webhook (Slack, PagerDuty). Anomaly detection is available on supported insights.

## 7. Feature flags

- **Frontend:** `posthog.isFeatureEnabled("flag")` / `posthog.onFeatureFlags(...)`
  via `posthog-js` (already initialized).
- **Backend:** `s.analytics.IsFeatureEnabled(userID, "flag")` and
  `s.analytics.AllFlags(userID)`; `GET /api/flags` returns all evaluated flags for
  the current user. Local evaluation (fast, no per-call network) kicks in when
  `POSTHOG_PERSONAL_API_KEY` is set.

## 8. Deploy annotations

`deploy.yml` posts an annotation to PostHog after each API deploy (best-effort,
skipped if `POSTHOG_PERSONAL_API_KEY` / `POSTHOG_PROJECT_ID` are absent) so deploys
show as markers on your charts — handy when correlating an anomaly with a release.
Note the annotations REST host is the **app** host (`https://us.posthog.com`), not
the ingestion host (`us.i.posthog.com`).

---

## 9. Instrumenting a NEW feature (do this every time)

Analytics is part of the definition of done for a feature, alongside its visual
E2E test. When you add a feature:

1. **Backend** — in the success path of the handler, after the DB write:
   ```go
   s.analytics.Capture(uid, "thing_happened", map[string]any{
       "thing_id": uuidStr(t.ID),
       "some_dimension": t.Kind,
   })
   ```
   Use `snake_case` event names (verb in past tense) and include the IDs/dimensions
   you'll want to filter or break down by. It's a no-op when analytics is off, so
   no guard needed. Request telemetry (`api_request`) is automatic for new routes.

2. **Frontend** — add a UI/intent event for anything the server can't observe
   (opening a screen, toggling, copying). Add the name to `EVENTS` in
   `apps/web/src/analytics.ts` and call `analytics.capture(EVENTS.yourEvent, {…})`.
   Autocapture + pageviews are automatic.

3. **Identify** any new person properties via `analytics.identify` (web) or
   `s.analytics.Identify` (api) — never put PII you don't need.

4. **Document** the new events in §5 above, and (optionally) add the insight/alert
   in PostHog.

Keep it lean: backend owns authoritative business events; frontend owns
intent/UX signals; don't double-count the same thing from both sides.
