# Quiet Plans — a restraint pass on House Lights

**Status:** approved and IN PROGRESS (2026-08). Phases 1-3 below are shipped: the `styles.css`
foundation classes (`.list`/`.list-row`, `.stamp-text`, `.toggle-quiet`, `.bare-day`), Home's event
rows, Groups' public + member event lists, EventPage's RSVP toggle, and `MonthPicker`'s date grid
(`ui.tsx`, used by `NewEvent` and the hero's add-date flow) all run the Quiet Plans language now.
`apps/web/public/free-scheduler/index.html` shipped the full treatment plus an auto-create flow (no
button - the link appears once there's enough info; the date grid then locks, since the API has no
endpoint to add poll days to an event that's already been created).
**Deliberately NOT converted yet** (see §3 for why): the drag-paint availability/voting grids
(`DayGrid`/`TimeGrid` - week/month/dates-scope), Discover's `PublicEventRow` (a richer two-row card,
not a simple list tile - a card border earns its keep there), a full pill-by-pill audit of
Profile/Friends/Calendars, and the nav/tabbar (its border already separates two real things - the
fixed bar from scrolling content - so it doesn't need to change).
**Executor:** any Claude model. Each phase is self-contained; follow it literally.
**Never do more than the phase you were asked to run.**

---

## 0. The direction in one paragraph

Quiet Plans is House Lights, turned down — not a new brand, not a new palette, not a new
typeface. Same plum stage, same cream ink, same one warm coral spent on action. What changes is
how much chrome sits around all of it: fewer bordered boxes, more whitespace doing the work a
border used to do, pills reserved for things that are actually information (a live count, a real
tally) rather than restating a status word, and one consistent visual grammar for "this is the
action or this is what you picked" (coral, whether that's a button or a selected date). The two
comps prove the direction holds from a single quiet marketing page (free-scheduler) through to the
denser real screens (a dashboard list, an event's RSVP row) without inventing anything new.

## 1. Anti-slop contract — House Lights §1 stays in force, unchanged

Every rule in `docs/design/HOUSE-LIGHTS.md` §1 (zero emoji, no gradients on interactive elements,
no `backdrop-filter`, stamp voice for dates/times/counts, Fraunces at display sizes only, no
exclamation marks, tokenized radii, one shadow per screen, icons from `Icons.tsx` only, the
untouchable list in §1.11, DB-stored values keep their keys) is still a hard rule here. Quiet Plans
adds three more, specific to the restraint pass:

13. **A border must separate two different things, never decorate one thing.** If removing a
    card's border and adding vertical rhythm (padding/gap) around it loses no information, the
    border was decoration — cut it. Borders that remain: nav from content, one list row from the
    next, the single hairline before a footer.
14. **A pill costs its keep with real state.** An RSVP tally, a live vote count, a follower
    count — pills, unchanged. A status word that only restates what's already obvious from
    context ("Deciding" under a title that has no other status) can drop to quiet text. When in
    doubt, keep the pill — this rule trims decoration, not information.
15. **Coral is one grammar, not two.** The primary action and "the thing you've selected" (a
    picked date, an active RSVP, a chosen chip) share the same coral language on a page. Don't
    introduce a second accent-adjacent color to mean "selected" if coral already means "chosen"
    elsewhere on the same screen.

## 2. What actually changes (component-by-component)

Reference the before/after strip in `quiet-plans-comp.html` for the visual target. In code terms:

- **`.card`** — stop defaulting to a bordered box. Where a card sits inside a list of similar
  cards (Home tiles, Group event rows), replace the per-card border with a shared hairline between
  rows (`border-top` on all but `:first-child`, or a `gap` + divider approach) and let padding do
  the separating. Where a card is genuinely a standalone module on an otherwise busy screen (the
  EventPage hero, a modal), it can keep its border — Quiet Plans thins the *default*, it doesn't
  ban borders outright.
- **Status pills** — audit every `.pill` usage (`grep -rn 'className="pill' apps/web/src`). Sort
  into "carries a number/tally" (keep) vs "restates a static status word" (candidate to become
  plain `.stamp`-voice text, no border/background). Do this audit as its own step before touching
  any JSX — it's the part most likely to remove something that was actually load-bearing.
- **Date/time grids** (`AvailabilityGrid`, the general-poll voting grid, `NewEvent`'s calendar
  day-picker) — the signature move: bare numerals, no per-cell border in the resting state, a
  coral (or `--go`/`--time` where the cell means something other than "selected") filled circle
  under the numeral when picked/hot. This is the highest-risk phase — these grids carry real
  interaction density (drag-to-paint, heatmap intensity, multi-user dot overlays) that a bare
  treatment must not regress. Prototype one grid in isolation before touching all three.
- **Inputs** — text inputs on quiet, low-stakes forms (profile fields, a title field) can move to
  underline-only per the free-scheduler precedent. Inputs inside dense multi-field forms
  (`NewEvent`'s full create form, event edit) stay boxed — an all-underline dense form reads
  worse, not calmer; restraint applied to the wrong place becomes illegible instead of quiet.
- **RSVP / response controls** — the three-state Going/Maybe/Can't-go control can move from filled
  buttons to the dot-plus-text pattern shown in the comp, IF the tap target still meets the 44px
  minimum (House Lights §1.11 — non-negotiable) and the change doesn't reduce it to text-only on
  mobile where a bigger hit area matters more than visual quiet.

## 3. Phases (run in order, one PR each; screenshot + look before merging)

0. **Comps** (done). `quiet-plans-comp.html` + free-scheduler in production are the visual source
   of truth for every decision below.
1. **Token/CSS foundation** (done). `.list`/`.list-row`, `.stamp-text`, `.toggle-quiet`, `.bare-day`
   added to `styles.css`, additive only - nothing existing was changed or removed.
2. **Home** (done). Event tile rows (`EventRow`, `FollowedTile`) → `.list-row`. Pills kept as-is
   (Draft/Can't go/Attended/Passed/soon-label/Polling/Set carry real, scannable state - §2's "keep
   the pill" default applied deliberately, not by default inertia).
3. **EventPage** (done). RSVP row → `.toggle-quiet` dot pattern. Hero card border stays (it's the
   one standalone module on the page, see §2). Drive-by fix: removed a stray "⏳" emoji from the
   waitlist note (pre-existing House Lights §1 violation, unrelated to this pass but caught while
   editing the same block).
3.5. **Groups** (done, folded into the EventPage PR). Public + member event lists → `.list-row`,
   same pattern as Home. `PublicEventRow` on Discover was left as a bordered card on purpose - it's
   a richer two-row layout (thumb+title, then a follow-button row), not a simple list tile, so a
   border still earns its keep there (§2).
3.6. **MonthPicker** (done, folded into the same PR). `ui.tsx`'s day-of-month grid (used by
   `NewEvent`'s "pick days" scope and the hero's add-date flow) → `.bare-day`. This is the SAME
   simple click-toggle pattern as the free-scheduler's own calendar, so it carried over directly
   with no new risk.
4. **Grids** (NOT done - still the highest-risk phase). `DayGrid`/`TimeGrid` (week/month/dates-scope
   availability + voting grids) keep their existing `.cell` treatment. These carry drag-to-paint,
   heatmap intensity tiers, and multi-user responder-dot overlays that a bare-numeral swap could
   easily regress - prototype ONE grid in isolation, screenshot it, before touching all three.
5. **Profile + Friends + Calendars** (NOT done). A full pill/card audit of these pages hasn't
   happened yet - Home/Groups were done because they're the highest-traffic surfaces; these are the
   natural next slice, same method (§2).
6. **Nav/tabbar** (deliberately skipped, not deferred). Its border already separates two real
   things - the fixed bottom bar from scrolling page content - so §1 rule 13 says it stays.
7. **Closeout**: update `CLAUDE.md`'s look-and-feel paragraph to mention Quiet Plans as the current
   execution of House Lights (not a replacement doc — House Lights stays the token source of
   truth), and retire this file's "Status" line to "shipped."

## 4. Verification loop (run at the end of EVERY phase)

Run House Lights §9 in full (the emoji/gradient greps, `make test`) plus:

```bash
# Borders-as-decoration check: flag any NEW bordered box added this phase that isn't
# separating two different things (manual review - no reliable grep for "decorative").
git diff --stat apps/web/src/styles.css apps/web/src/**/*.tsx

# Full visual sweep - a phase that touches shared classes (.card, .pill, .row) can shift
# screenshots on pages it didn't mean to touch. Expect and review ALL diffs, not just the
# page you changed.
make e2e-update && git diff --stat e2e/
```

Screenshot self-critique, in addition to the existing House Lights checklist:
- Does every remaining border separate two *different* things, or did one survive out of habit?
- Is coral still doing exactly one job on the screen (the action, or the pick) — not two?
- Did a pill get removed that was actually the only place a real count/tally showed?
- On mobile, are RSVP/response and date-grid tap targets still comfortably 44px, not just visually
  quieter?
