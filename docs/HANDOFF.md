# Handoff — state of the work and exactly what to do next

**Written Aug 12 2026, at the end of the Fable-orchestrated session** (House Lights redesign + venue-pages
platform shift). Everything below is executable by any Claude model or a human. The three living documents:

- `docs/design/HOUSE-LIGHTS.md` — design system + anti-slop contract (§1 = hard rules for ALL UI work).
- `docs/product/VENUE-PAGES.md` — the pages/following platform playbook (V1–V7; V1–V6 shipped).
- `docs/product/LAUNCH.md` — go-public checklist and the getting-people plan. **Start here next session.**

## What is DONE on `app/scheduler` (local commits, tests green at every merge)

- **House Lights redesign, phases 1–7 + most of 8**: plum-stage palette derived from the wordmark,
  Fraunces/Familjen/Spline Mono type system, zero emoji + `Icons.tsx`, candy-stripe brand moments,
  TitlePoster playbill fallbacks, restyled emails/OG cards/confirmation pages, performer-first landing
  ("Build a following. Fill the room."), regenerated marketing shots + OG card, CLAUDE.md look passage
  rewritten, orphaned preferences route unwired.
- **Venue pages V1–V6**: public `/g/{id}` pages (view + follow) with signed revocable join links,
  follower counts, share-your-page card, past-shows section, following feed on Home ("From pages you
  follow" + Following chip), daily follow-digest email (claim-before-send, one-tap RSVP, unfollow links),
  create-your-page onboarding (landing CTA → sign-up → purpose-tuned group creation → share card →
  post-first-event nudge), full funnel instrumentation (`page_viewed`, `follow_clicked`,
  `public_page_served`, sourced signups).

## What is IN FLIGHT / NOT DONE

1. **Visual E2E baselines** — a full `make e2e-update` was launched at session end. If its baselines got
   committed (check `git log` for a baselines commit), they were **NOT eyeball-reviewed**: before trusting
   them, open the changed PNGs under `e2e/tests/*-snapshots/` and check against the contract (plum bg,
   no glass, mono stamps, plum-on-coral buttons, zero emoji). If the run instead surfaced BEHAVIOR
   failures, fix those before anything else — known suspects: an OG-unfurl test that needs the
   nginx-fronted stack, and a "pick-days poll" flake (both pre-existing, documented in session notes).
2. **V7 — performers on events** (follow a person → see events they're on). Spec: VENUE-PAGES.md §V7
   (decisions are final — consent-gated distribution via pending/confirmed, `perf|` HMAC one-tap links,
   no new follow kind). A substantial WIP exists on branch `worktree-agent-a2f88e8e92ce7a0cd`
   (worktree `.claude/worktrees/agent-a2f88e8e92ce7a0cd`, WIP commit "WIP: performers on events") —
   migration 0046 + handlers + Lineup UI + e2e were largely built and the migration applied cleanly;
   it was stopped mid-e2e-run. **Resume by finishing that branch** (run its tests, fix, commit properly),
   rebase onto `app/scheduler` tip, merge. Do not rewrite from scratch.
3. **Phase 8 leftovers**: delete orphaned baseline PNGs for tests that no longer exist; a final §9 grep +
   `make test` sweep after the baselines land.

## Deploy

The push at session end (if CI is green) deploys via the existing pipeline. If CI failed on the e2e job,
the failure is almost certainly visual baselines (see 1 above) — regenerate/commit/review, push again.
After first successful deploy, walk `docs/product/LAUNCH.md` section A top to bottom (Clerk surface
styling is the highest-leverage remaining UI gap — it sits on the create-your-page conversion path).

## Rules for whoever continues

- Read `CLAUDE.md` first, always. Then the §1 contract in HOUSE-LIGHTS.md before touching any UI.
- One phase / one concern per PR-sized commit; run `make test` before every commit; never push red.
- Use cheap models for mechanical work, and require every agent to end with the §9 verification loop.
- Product decisions already made are recorded in VENUE-PAGES.md "Decisions" — do not relitigate them
  without the user.
