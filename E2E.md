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

**Summary: ✅ 7 passed · 1 skipped · 0 failed · 0 flaky** (assertion pass)

| Spec | Test | Asserts | Result | Time |
|---|---|---|---|---|
| `scheduler.spec.ts` | create an event, respond as a guest, host sees preferences | behavior | ✅ pass | 1.2 s |
| `scheduler.spec.ts` | create a general-availability poll and respond | behavior | ✅ pass | 834 ms |
| `scheduler.spec.ts` | create form visual baseline | visual (`new-event-form.png`) | ✅ pass | 531 ms |
| `scheduler.spec.ts` | specific-times poll: vote and finalize | behavior | ✅ pass | 1.0 s |
| `scheduler.spec.ts` | edit profile and weekly availability | behavior | ✅ pass | 481 ms |
| `scheduler.spec.ts` | upload a profile photo | behavior | ✅ pass | 425 ms |
| `scheduler.spec.ts` | friends: request, accept, and view availability | behavior (2 users) | ✅ pass | 863 ms |
| `screenshots.spec.ts` | capture scheduler pages | — (docs capture) | ⏭️ skipped | — |

```
Running 8 tests using 2 workers
  ✓  create an event, respond as a guest, host sees preferences (1.2s)
  ✓  create a general-availability poll and respond (834ms)
  ✓  create form visual baseline (531ms)
  ✓  specific-times poll: vote and finalize (1.0s)
  ✓  edit profile and weekly availability (481ms)
  ✓  upload a profile photo (425ms)
  ✓  friends: request, accept, and view availability (863ms)
  1 skipped
  7 passed (7.3s)
```

### Coverage map (behavior → test)

| Behavior | Covered by |
|---|---|
| Profile setup + edit, weekly availability | edit profile and weekly availability |
| Profile photo upload (client resize → data URL) | upload a profile photo |
| Create event (fixed) + RSVP + preference Q&A | create an event, respond as a guest… |
| Specific-times poll: vote + host finalize | specific-times poll: vote and finalize |
| General availability poll (per-day grid) + aggregate | create a general-availability poll and respond |
| Friends: add by handle, accept, view availability | friends: request, accept, and view availability |
| Create form appearance | create form visual baseline |

Not E2E-covered (by design): the **Clerk** sign-in path (E2E runs dev-auth; Clerk has its own testing token path in non-dev runs), and **analytics** delivery (disabled in E2E; the no-op path is exercised).

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

### `scheduler.spec.ts` › create a general-availability poll and respond
1. Create an event with the **general** scheduling mode.
2. Preview as guest → RSVP → pick an ideal **month**, **weekday**, and **time of
   day**, then save.
3. Back in the host view, assert the **Group availability** aggregate reflects the
   pick (e.g. "Evening" appears).

Exercises: `POST /api/events` (general mode), `POST /api/events/{id}/general-votes`,
and the role-aware aggregation in `GET /api/events/{id}`.

### `scheduler.spec.ts` › create form visual baseline
Navigates to `/new`, selects a known event type, and snapshots the create form
(`new-event-form.png`). A deterministic region (no dates/accumulated data), so the
pixel baseline is stable across machines and CI.

### `scheduler.spec.ts` › specific-times poll: vote and finalize
Create a poll with two candidate times → preview as guest → vote 👍 on both →
host **Picks** the first option → assert the event flips to **Confirmed**.
Exercises `POST /api/events/{id}/votes` and `POST /api/events/{id}/finalize`.

### `scheduler.spec.ts` › edit profile and weekly availability
Edit the name, toggle weekly availability cells, save. Exercises `PUT /api/profile`
and `PUT /api/availability`.

### `scheduler.spec.ts` › upload a profile photo
Upload a PNG via the file input; the client resizes it to a JPEG data URL and
saves it. Asserts the avatar renders with a `data:image/…` src. Exercises
`PUT /api/profile/avatar`.

### `scheduler.spec.ts` › friends: request, accept, and view availability
Two browser contexts (two dev users via `?as=`): Ben sets availability, Amy adds
Ben by handle, Ben accepts, Amy opens Ben's availability. Exercises
`POST /api/friends`, `POST /api/friends/{id}/accept`,
`GET /api/friends/{id}/availability`.

> The scheduler tests share the dev stub user (`demo-user`) and its profile, so the
> spec is configured `mode: "serial"` — they run in order instead of racing workers
> over the same first-run setup. The friends test uses its own `amy`/`ben` users in
> separate contexts.

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
