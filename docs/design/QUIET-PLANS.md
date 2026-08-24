# Quiet Plans — a restraint pass on House Lights

**Status:** approved and WIDELY SHIPPED (2026-08). The restraint pass now covers every page:
Home, Groups (list + public + member pages), EventPage (RSVP toggle, Lineup, Invite friends,
Add-to-calendar, Series, ShareLink, PollResults, Guests, all the one-off banners), Friends,
Profile, Calendars, the shared skeletons (`ListSkeleton`/`EventSkeleton`), `ClerkAccount`, the
guest banner in `App.tsx`, and `MonthPicker` (`ui.tsx`, used by `NewEvent` and the hero's add-date
flow). `apps/web/public/free-scheduler/index.html` shipped the full treatment plus an auto-create
flow (no button - the link appears once there's enough info; the date grid then locks, since the
API has no endpoint to add poll days to an event that's already been created).

**The rule that decided every card, restated concretely:** a list of similar items (event tiles,
friends, group members, calendar providers, guests) → `.list`/`.list-row`, hairline between rows.
A single-purpose info card that isn't a list and isn't a form (Add to calendar, RSVP, Lineup,
Invite friends, Series, ShareLink, one-off dismissible banners, the Profile summary/Appearance/
help cards) → drop the box, keep the heading, let whitespace separate it from its neighbors. A
genuine multi-field FORM (create-group, create-event, hero-edit, general-setup, add-friend,
profile-edit), a `<details>` disclosure (comments, vote-details, group-public-past), a modal (crop
dialog), or anything sitting directly against a drag-paint grid (Profile's availability card,
EventPage's general-results) keeps its card - forms and disclosures need the boundary to read as
one unit, and grid-adjacent cards are explicitly deferred to the grids phase below so the two
changes never get tangled in one diff. Two explicit product-reasoning exceptions, kept boxed on
purpose per existing CLAUDE.md docs: Groups' `group-share-page-card` and `group-invite-card` stay
TWO SEPARATE bordered cards (not two sections of one) so a host can never mistake "share the page"
for "hand out membership" - removing the boxes would blur exactly the distinction they exist to
make.

**Deliberately NOT converted yet** (see §3 for why): the drag-paint availability/voting grids
(`DayGrid`/`TimeGrid` - week/month/dates-scope, plus the cards directly wrapping them), Discover's
`PublicEventRow` (a richer two-row card, not a simple list tile - a card border earns its keep
there), and the nav/tabbar (its border already separates two real things - the fixed bar from
scrolling content - so it doesn't need to change).
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
3.5. **Groups** (done). Public + member event lists → `.list-row`, same pattern as Home; the main
   groups list, `GroupMembersPage`'s member list, and the one-off dismissible banners
   (`group-page-live`, `group-link-hint`, `group-unlisted-hint`, `group-members-link`) all dropped
   their boxes too. `group-share-page-card`/`group-invite-card` and `group-public-card` (the page's
   own header/poster) stay boxed on purpose - see the exceptions above. `PublicEventRow` on
   Discover was left as a bordered card on purpose - it's a richer two-row layout (thumb+title,
   then a follow-button row), not a simple list tile, so a border still earns its keep there (§2).
3.6. **MonthPicker** (done). `ui.tsx`'s day-of-month grid (used by `NewEvent`'s "pick days" scope
   and the hero's add-date flow) → `.bare-day`. This is the SAME simple click-toggle pattern as the
   free-scheduler's own calendar, so it carried over directly with no new risk.
3.7. **EventPage, full pass** (done). Beyond the RSVP toggle: `Lineup` and `InviteFriends` → lists
   of people (`.list-row`), `Guests` → grouped lists per RSVP status, `AddToCalendar`/`SeriesCard`/
   `ShareLink`/`PollResults`/`vote-first` dropped their boxes (matching Rsvp's own treatment - they
   share its visual role), and the small banners (`draft-banner`, `cancelled-note`,
   `pending-performer-banner`, `poll-closed`) went boxless too. `general-results` (wraps the
   drag-paint heatmap) was left alone - deferred with the grids in phase 4 below, not touched
   separately, so the two changes can't get tangled in one diff. Two more emoji drive-by fixes
   caught while editing this file: a stray "⏳" on the waitlist note, and "⬇️" on the .ics download
   button (both pre-existing House Lights §1 violations, unrelated to this pass).
3.8. **Profile + Friends + Calendars, full pass** (done). Friends: the incoming/suggestions/
   outgoing lists and each `FriendCard` → `.list-row` (`FriendCard`'s own expandable availability
   panel needed an `alignItems:"stretch"` override alongside `.list-row` - see the note in §2 about
   combining it with `.stack`). Profile: the read-only summary, Appearance, and Help cards dropped
   their boxes; the edit form and the availability card (wraps `DayGrid`) stay, the latter deferred
   with the grids. Calendars: `DayList`, `FeedCard`, and `CalendarConnections`' provider rows
   (`ProviderRow` needed the same `alignItems:"stretch"` fix as `FriendCard`) all converted.
   `ClerkAccount`'s account card and the guest banner in `App.tsx` also dropped their boxes for the
   same reason - they're single-purpose info, not lists or forms. The shared skeletons
   (`ListSkeleton`/`EventSkeleton` in `ui.tsx`) were updated to match - a boxed skeleton loading
   into boxless real content was a visible seam.
4. **Grids** (NOT done - still the highest-risk phase, deliberately untouched). `DayGrid`/`TimeGrid`
   (week/month/dates-scope availability + voting grids) and every card that wraps them directly
   (Profile's availability card, EventPage's `general-results`) keep their existing `.cell`/`.card`
   treatment. These carry drag-to-paint, heatmap intensity tiers, and multi-user responder-dot
   overlays that a bare-numeral swap could easily regress - prototype ONE grid in isolation,
   screenshot it, before touching all three.
5. **Nav/tabbar** (deliberately skipped, not deferred). Its border already separates two real
   things - the fixed bottom bar from scrolling page content - so §1 rule 13 says it stays.
6. **Closeout**: update `CLAUDE.md`'s look-and-feel paragraph to mention Quiet Plans as the current
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
