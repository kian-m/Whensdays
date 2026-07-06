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

**Run:** 2026-07-06 · `make e2e-docker` · Chromium (Desktop Chrome), Playwright
v1.49.1 · pinned `timezoneId: UTC`, `locale: en-US`.

**Summary: ✅ 44 passed · 1 skipped · 0 failed · 0 flaky** (assertion pass; the
baseline pass regenerates visual snapshots first).

The suite is the source of truth for what's covered — one `test(...)` per
behavior in `e2e/tests/scheduler.spec.ts` (events, polls, availability,
friends, groups, guests, discover/feed, comments incl. GIFs, covers/themes,
invites, deletion, recurring series, calendar export) and
`e2e/tests/calendars.spec.ts` (import, stub mode). Read the test titles for the
inventory; this file intentionally doesn't duplicate them per-test (it rotted
within a week when it did).

### Conventions that keep the suite green

- **Two-pass runs share one database.** Every test must be idempotent across a
  second run: unique titles (`test.info().testId`, plus `Date.now()` where the
  same test re-runs against diverged state), tolerate pre-existing
  profiles/friendships, and clean up state that would change another test's
  starting point.
- **Deterministic visuals only.** Snapshot stable regions, never lists that
  accumulate rows; animations are frozen (`toHaveScreenshot` does this by
  default; docs captures pass `animations: "disabled"`).
- **Stub modes over network.** `AUTH_MODE=dev`, `CALENDAR_MODE=stub`,
  `KLIPY_MODE=stub` keep runs hermetic — no external accounts, keys, or
  network calls.
- **Generous timeouts on cross-context renders** (ranked feeds, lazy-loaded
  chunks) — CI runners are slow; a 5s default is the main flake source.

Not E2E-covered (by design): the **Clerk** sign-in path (E2E runs dev-auth;
Clerk has its own testing-token path in non-dev runs), **analytics** delivery
(disabled in E2E; the no-op path is exercised), and the **live Klipy API**
(stubbed; the proxy's URL-validation is unit-testable Go).
