# End-to-end tests

Every feature in this app ships with a Playwright end-to-end test that asserts
**behavior** and, where it makes sense, a **visual baseline** (`toHaveScreenshot`).
The tests run against the real, prod-shaped stack — nginx web → Go API →
Postgres — in hermetic **dev auth mode** (no Clerk account needed).

## How to run

```bash
make e2e-docker
```

This builds Postgres + API + web + a Playwright runner (`compose.e2e.yaml`) and
runs the suite in two passes: first `--update-snapshots` to (re)generate visual
baselines, then a clean assertion pass against them. It's the same path CI runs.
Baselines are committed under `e2e/tests/*-snapshots/` as `*-chromium-linux.png`.

To update a baseline after an intentional UI change: `make e2e-update` (review the
diff before committing).

## Latest results

**Run:** 2026-06-26 · `make e2e-docker` · Chromium (Desktop Chrome), Playwright
v1.49.1 · pinned `timezoneId: UTC`, `locale: en-US`.

**Summary: ✅ 2 passed · 1 skipped · 0 failed · 0 flaky** (assertion pass)

| Spec | Test | Asserts | Result | Time |
|---|---|---|---|---|
| `scheduler.spec.ts` | create an event, respond as a guest, host sees preferences | behavior | ✅ pass | 740 ms |
| `scheduler.spec.ts` | create form visual baseline | visual (`new-event-form.png`) | ✅ pass | 443 ms |
| `screenshots.spec.ts` | capture scheduler pages | — (docs capture) | ⏭️ skipped | — |

```
Running 3 tests using 2 workers
  ✓  scheduler.spec.ts:41:3 › scheduler › create an event, respond as a guest, host sees preferences (740ms)
  ✓  scheduler.spec.ts:70:3 › scheduler › create form visual baseline (443ms)
  1 skipped
  2 passed (2.2s)
```

## What each test covers

### `scheduler.spec.ts` › create an event, respond as a guest, host sees preferences
The core happy path, end to end:
1. First-run **profile setup** (name + handle) when needed.
2. Create a **fixed-time dinner** at the host's place via `/new`.
3. Land on the **event page (host view)** — asserts the title and the host-only
   **invite link** are present.
4. **👀 Preview as guest** → **RSVP "Going"** → answer the **one-question-at-a-time
   preference flow** (dietary → cuisine).
5. Back in the **host view**, assert the guest's answer ("Vegetarian") shows up in
   the preference summary.

Exercises: `PUT /api/profile`, `POST /api/events`, `GET /api/events/{id}`
(role-aware), `POST /api/events/{id}/rsvp`, `POST /api/events/{id}/preferences`.

### `scheduler.spec.ts` › create form visual baseline
Navigates to `/new`, selects a known event type, and snapshots the create form
(`new-event-form.png`). A deterministic region (no dates/accumulated data), so the
pixel baseline is stable across machines and CI.

> The two scheduler tests share the dev stub user (`demo-user`) and its profile, so
> the spec is configured `mode: "serial"` — they run in order instead of racing two
> workers over the same first-run setup.

### `screenshots.spec.ts` › capture scheduler pages
Not an assertion test — it regenerates the README/gallery screenshots
(`docs/screenshots/01-scheduler-home.png`, `02-scheduler-event.png`) from the live
app. It is **skipped during E2E** and runs only via `make docs-shots`
(`DOCS_SHOTS=1`).

## Committed visual baselines

| Baseline | Source test |
|---|---|
| `e2e/tests/scheduler.spec.ts-snapshots/new-event-form-chromium-linux.png` | create form visual baseline |

## Related checks (not E2E)

- **Go unit tests** — `cd apps/api && go test ./...` (handler validation + helpers); run in CI's `api` job.
- **Web typecheck** — `pnpm typecheck` (strict TS); run in CI's `web` job.
