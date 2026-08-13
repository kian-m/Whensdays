# House Lights — the Whensdays design revamp playbook

**Status:** direction approved from `docs/design/house-lights-comp.html` (open it in a browser — it is the
visual source of truth for every token, component, and copy decision below).
**Executor:** any Claude model. Each phase is self-contained; follow it literally.
**Never do more than the phase you were asked to run.**

---

## 0. The direction in one paragraph

House Lights = a small theater just before the show starts. The audience of this product is improv jams,
comedy nights, and standing friend groups, so the design borrows their world: show posters, playbills,
ticket stamps, marquee type. Every color is extracted from the existing wordmark (`apps/web/public/icon.svg`):
plum `#2f2440` becomes the stage, cream the ink, and the W's three candy stripes become *functional* color —
teal = going/free, amber = time/pending, coral = action. The cursive `hensdays` wordmark and the W icon are
**unchanged** — they are the seed of the system, not a casualty of it.

## 1. The anti-slop contract (read before every phase, check before every commit)

These are hard rules. If a change would violate one, the change is wrong — not the rule.

1. **Zero emoji anywhere in the product.** Not in labels, buttons, headers, empty states, emails, pills,
   placeholders, or fallback tiles. Also no unicode dingbats standing in for icons (✓ ✕ ✎ ← in UI strings).
   Icons come only from `Icons.tsx` (§5). Verification: the grep in §9 must return zero.
2. **No gradients on interactive elements.** The only gradients allowed in the entire app: the candy
   `--stripe`, the skeleton shimmer, and poster/theme washes on non-interactive surfaces.
3. **No `backdrop-filter`, no animated background.** Surfaces are solid `--surface` with hairline `--line`
   borders and the `--grain` texture on `body` and posters only.
4. **No white/cream text on coral fills.** Primary buttons are plum-on-coral (validated 4.8:1). Hover flips
   to `--coral-deep` with cream text (that pairing passes).
5. **Dates, times, counts, and status pills always use the stamp voice** (Spline Sans Mono, uppercase,
   letterspaced, tabular). Nothing else ever uses it — body copy never goes mono, mono never does sentences.
6. **Fraunces only at display sizes** (≥1.2rem) — titles, page headings, posters, the lock banner. Never in
   buttons, labels, or body copy.
7. **No exclamation marks in UI copy.** Warmth comes from wording, not punctuation.
8. **Radii only from tokens** (`--r` 12 / `--r-sm` 8 / `--r-xs` 5). Never fully-rounded pills, never
   `border-radius: 999px` (exception: avatars/facepiles are circles).
9. **One shadow per screen** — the element that must float (modal, phone-frame, active card). Everything
   else is flat with borders.
10. **Icons are information, not decoration.** Max ~1 icon per control; most buttons and section headers are
    words only. Meta rows (when/where), tab bar, and close/check affordances are the icon budget.
11. **Do not touch:** `data-testid` attributes, server code, analytics event names, guest-flow logic, route
    paths, maxLength caps, 44px min tap targets, `white-space: nowrap` on `.btn`/`.chip`,
    `prefers-reduced-motion` handling, or the iOS datetime input fixes. These are product invariants
    documented in CLAUDE.md.
12. **DB-stored values keep their keys.** `eventThemes` keys, event type values, and group icon emoji stay
    valid server-side; only their *rendering* changes.

## 2. Design tokens (paste-ready)

Replace the current `:root` / `[data-theme="light"]` blocks in `apps/web/src/styles.css` with these.
Keep any token not listed here (grid sizing vars etc.) unless a later phase retires it.

```css
:root {
  /* stage (dark, default) */
  --bg: #1a1424;
  --surface: #241c31;
  --surface-2: #2b2239;
  --line: #3a2f4d;
  --ink: #f2e9dc;
  --muted: #a596b4;
  --plum: #2f2440;        /* logo dark: button text, poster bg, avatar bg */
  --cream: #f8e3c9;       /* logo cream: poster type, hover button text */
  --accent: #ee6c4d;      /* coral — action only */
  --accent-deep: #c14e33;
  --time: #e9a13b;        /* amber — datetimes, pending, marquee */
  --go: #3aa38b;          /* teal — going / free / success */
  --maybe: #e9a13b;       /* alias of --time */
  --no: #e0607a;          /* rose — busy / declined / destructive */
  --r: 12px; --r-sm: 8px; --r-xs: 5px;
  --shadow: 0 24px 60px rgba(0,0,0,0.45);
  --stripe: linear-gradient(90deg, var(--accent) 0 25%, var(--time) 25% 50%, var(--go) 50% 75%, var(--cream) 75% 100%);
  --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E");
  --font-display: 'Fraunces Variable', Georgia, serif;
  --font-body: 'Familjen Grotesk Variable', system-ui, -apple-system, sans-serif;
  --font-data: 'Spline Sans Mono Variable', ui-monospace, 'SF Mono', monospace;
}
[data-theme="light"] {
  /* matinee — same theater, house lights up */
  --bg: #faf5ec;
  --surface: #ffffff;
  --surface-2: #f3ecdd;
  --line: #e5dccb;
  --ink: #2f2440;
  --muted: #6f6280;
  --plum: #2f2440;
  --cream: #f8e3c9;
  --accent: #ee6c4d;      /* fills only (plum text on it) */
  --accent-deep: #c14e33; /* use for coral text/links on paper (4.4:1) */
  --time: #9c6614;        /* amber deepened for paper (4.5:1) */
  --go: #2b7f6c;
  --no: #c14458;
  --shadow: 0 18px 44px rgba(47,36,64,0.14);
}
```

Rules that ride the tokens:
- Links / coral text: `var(--accent)` on dark, `var(--accent-deep)` on light — define once:
  `a, .linklike { color: var(--accent) } [data-theme="light"] a, ... { color: var(--accent-deep) }`.
- `body { background: var(--bg) var(--grain); color: var(--ink); font-family: var(--font-body) }`.
- Delete: `--sky`, `--cloud-*`, all `--glass*` tokens, `body::before/::after` cloud layers, every
  `backdrop-filter`, `--accent-soft` (replace uses with `--surface-2`).
- **Dark stays the default theme** (no-flash script and toggle already exist — unchanged).

## 3. Typography

Install (adds ~3 packages, all latin variable subsets):

```
cd apps/web && pnpm add @fontsource-variable/fraunces @fontsource-variable/familjen-grotesk @fontsource-variable/spline-sans-mono
```

In `main.tsx` (before styles.css import):

```ts
import '@fontsource-variable/fraunces/opsz.css';       // needs the opsz axis file
import '@fontsource-variable/familjen-grotesk';
import '@fontsource-variable/spline-sans-mono';
```

If an import path 404s, list `node_modules/@fontsource-variable/<pkg>/*.css` and pick the file that
includes latin + the needed axes. Do not add any other family or weight file.

Type scale (replace current h1/h2/h3/.section-h/.pill rules):

| Role | Class/element | Spec |
|---|---|---|
| Display XL | `.land-title` | Fraunces 900, `clamp(2.9rem, 9vw, 5rem)`, lh 0.98, ls −0.02em |
| H1 (event/page titles) | `h1` | Fraunces 900, 1.7rem, lh 1.05, ls −0.02em |
| H2 | `h2` | Fraunces 900, 1.35rem |
| H3 (card titles) | `h3` | Familjen 700, 1.05rem (NOT Fraunces — cards stay quiet) |
| Body | `body, p` | Familjen 400, 1rem, lh 1.5 |
| Small | `.small` | 0.85rem, `--muted` |
| Section label | `.section-h` | Spline Mono 600, 0.72rem, uppercase, ls 0.14em, `--muted` |
| Stamp (datetime/count) | `.stamp` | Spline Mono 600, 0.8rem, uppercase, ls 0.1em, tabular-nums; time stamps colored `--time` |
| Pill | `.pill` | Spline Mono 600, 0.66rem, uppercase, ls 0.12em |

Add `font-variant-numeric: tabular-nums` to `.stamp`, `.pill`, grids, and any count.
`fmtDate`/`fmtDateTime` output should render inside `.stamp` spans wherever a date/time shows.

## 4. Component respecs (match the comp exactly)

- **`.card`** — `background: var(--surface); border: 1px solid var(--line); border-radius: var(--r)`.
  No blur, no glint, no glow. Padding 1rem.
- **`.btn.primary`** — coral fill, **plum text**, 1px `--accent-deep` border, radius `--r-sm`, Familjen 700.
  Hover: `--accent-deep` fill + `--cream` text. Keep existing press physics (translate/scale) and
  `:focus-visible` ring (recolor ring to `--time`). Disabled: opacity 0.45.
- **`.btn.ghost`** — transparent, `--ink` text, `--line` border. `.btn.quiet` (rename of `.soft`) —
  `--surface-2` fill. `.btn.danger` — transparent, `--no` text, `--line` border.
- **`.chip`** — outline like ghost; selected `.chip.on` = **teal fill, plum text** (not coral — selection is
  a state, coral is an instruction).
- **`.pill`** — mono uppercase, `--surface-2` bg, `--line` border, radius `--r-xs`, 6px colored dot.
  Kinds: `deciding`(amber, renames "polling" label to "Deciding"), `locked`(teal, label "Locked in"),
  `draft`(muted), `cancelled`(rose), `going/maybe/declined` (teal/amber/rose).
- **Hero card** — `::before` 3px `--stripe` top rule (hero card ONLY — no other card gets the stripe edge).
- **TitlePoster (new, in ui.tsx)** — the no-photo cover fallback replacing emoji/gradient tiles:
  plum block + `--grain`, event title (first ~2 words, or full if short) in Fraunces 900 cream at
  poster scale, a `.stamp` line in amber underneath (venue/city if known, else the event type label),
  faint radial cream light from top (see comp CSS `.poster`). Used by the hero when `photo_url` is empty
  and — at 56px thumb scale, initial letter only + 3px stripe bottom edge — by `EventThumb`.
- **Who's in** — progress bar fill = `--stripe` (5px, radius 3). Facepile: plum bg cream initials,
  2px `--surface` separation ring; friends get a 1.5px teal ring.
- **Lock banner (`.fx-locked`)** — stripe top rule, teal hairline border, `rgba(58,163,139,0.09)` wash,
  Fraunces 900 title "Locked in — {date}". **Delete the `.fx-burst` confetti entirely** — the stripe is the
  celebration. No entrance animation (iOS Low Power invariant).
- **Heat grids (DayGrid/TimeGrid results)** — cells show the count *inside* (mono 0.72rem); teal alpha steps
  0.16/0.34/0.55 by intensity; the best cell gets a 2px coral border + tiny "BEST" tag; empty cells show `·`.
  Keep all painting/voting interaction logic untouched — this is a rendering change only.
- **Tab bar** — solid `--surface`, top hairline, stroke icons from Icons.tsx, active = coral. No blur.
- **Skeletons** — keep, recolor to plum tones (`--surface-2` shimmer).
- **Toast** — `--surface` card, hairline border, no icon, e.g. "Saved".
- **Inputs** — `--bg` fill, `--line` border, radius `--r-sm`; keep 44px min-height + appearance:none fixes.
- **Event themes (`.theme-*`)** — keep the 8 keys (DB values). Restyle each as a *quiet wash*: a static
  radial tint of one hue over the stage + the matching `--accent` override. Delete `theme-flow` motion,
  particles remnants, and `.theme-tile` glow borders — themed tiles get a 3px bottom edge in the theme hue
  instead. Theme picker chips: color swatch + name, no emoji.
- **QR modal** — module color stays `pageAccent`-driven; frame becomes a plain `--surface` card.

## 5. Icons.tsx (complete — create `apps/web/src/Icons.tsx`)

Only these icons exist. 24-unit viewBox, 1.75 stroke, round caps/joins, `currentColor`.

```tsx
const P = (props: { d?: string; children?: React.ReactNode; size?: number; label?: string }) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 17} height={props.size ?? 17} fill="none"
    stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden={props.label ? undefined : true} role={props.label ? 'img' : undefined}
    aria-label={props.label}>{props.d ? <path d={props.d} /> : props.children}</svg>
);
export const Ic = {
  calendar: (s?: number) => <P size={s}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></P>,
  clock:    (s?: number) => <P size={s}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></P>,
  place:    (s?: number) => <P size={s}><path d="M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></P>,
  people:   (s?: number) => <P size={s}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><path d="M15.5 5.9a3.5 3.5 0 0 1 0 6.4M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></P>,
  bell:     (s?: number) => <P size={s}><path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2.5H4.5L6 16z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/></P>,
  comment:  (s?: number) => <P size={s} d="M4 5h16v11H9l-5 4V5z"/>,
  check:    (s?: number) => <P size={s} d="M5 13l4 4 10-10"/>,
  x:        (s?: number) => <P size={s} d="M6 6l12 12M18 6L6 18"/>,
  plus:     (s?: number) => <P size={s} d="M12 5v14M5 12h14"/>,
  link:     (s?: number) => <P size={s}><path d="M10 14a5 5 0 0 0 7 0l2.5-2.5a5 5 0 0 0-7-7L11 6"/><path d="M14 10a5 5 0 0 0-7 0L4.5 12.5a5 5 0 0 0 7 7L13 18"/></P>,
  home:     (s?: number) => <P size={s} d="M4 11l8-7 8 7v9h-5v-6h-6v6H4v-9z"/>,
  grid:     (s?: number) => <P size={s}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></P>,
  person:   (s?: number) => <P size={s}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></P>,
  camera:   (s?: number) => <P size={s}><path d="M4 8h3l2-2.5h6L17 8h3v12H4V8z"/><circle cx="12" cy="13.5" r="3.2"/></P>,
  edit:     (s?: number) => <P size={s} d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/>,
};
```

Wanting an icon not on this list means the design wants **a word instead**. Do not add icons without
updating this file AND the comp.

## 6. Emoji eradication map (Phase 2 — complete, mechanical)

Global rule first, then specifics. After this phase the §9 grep returns 0 matches under `apps/web/src`.

**Default replacement: delete the emoji and keep the words.** `"🔔 Mute notifications"` → `"Mute notifications"`.
Most emoji need nothing in their place — the label was always doing the work.

| Current | Replacement |
|---|---|
| `✓` confirmations ("Saved ✓", "Copied ✓", "Following ✓", "Request sent ✓") | Word only ("Saved", "Copied", "Following", "Request sent"). In buttons that flip state, prepend `Ic.check` |
| `✕` clear/remove buttons | `Ic.x` with `aria-label` preserved |
| `✎ Edit` | `Edit` (word only) |
| `📅 🗓` meta rows | `Ic.calendar` or `Ic.clock` (time-being-decided rows use clock) |
| `📍` location rows / "📍 Online" tiles | `Ic.place`; tiles: word "Online" |
| `💻 Join online` / `💻 Online` | `Ic.link` + "Join online" / word "Online" |
| `🔗 Invite via link` / copy-link | `Ic.link` + label |
| `🔔 / 🔕` mute toggle, Nudge | Words; Nudge button: word "Nudge" only |
| `🎉` ("You're invited 🎉", "It's locked in 🎉", "You're in 🎉") | Copy per §7; lock banner per §4 |
| `📝 Draft` pill/actions | Pill kind `draft`; "Move to drafts" word only |
| `📷 Add a photo` | `Ic.camera` + "Add a photo" |
| `👀 Preview as guest` | "Preview as guest" |
| `✅ Going / 🤔 Maybe` RSVP chips | Words; selected chip gets `Ic.check` (see comp) |
| `👍 👎 🤷` poll marks | "Yes" / "No" / "–" text, or `Ic.check`/`Ic.x`/`·` in tight cells |
| `🟢 N free / 🔴 N busy` fit chips | CSS dot spans (`--go` / `--no`) + mono counts |
| `🔥 N-month streak` | `.stamp` in amber: `6-MONTH STREAK` |
| `🔁 N dates / Repeats` badges | `.stamp`: `SERIES · 4 DATES` / "Repeats weekly · 1 of 4" plain text |
| `💬 N comments` | Section label `COMMENTS · N` |
| `📣 Nudged N people` | "Nudged N people" |
| `🗳 poll closed` | "This poll has closed" |
| `🕶/🕵 anonymous RSVP` | "Hide my name from the guest list" (checkbox label, no icon) |
| `👋` ("Welcome 👋", "say hi 👋") | Copy per §7 |
| `⚡` landing CTA | Copy per §7 |
| `🍪` cookie banner | "Cookies:" word |
| `🍎/📅` calendar providers (Calendars.tsx) | Text labels "Google Calendar", "Apple Calendar", "Calendar link (.ics)" |
| `🌎 Public` (Discover) | "Public" |
| `📲` homescreen prompt | "Add Whensdays to your home screen" |
| Category emojis (`CATEGORIES` in lib.tsx, 14 entries) | Chips render label only. Keep the emoji field in the data (used nowhere after this) or drop the field and every read of it |
| Theme entries (`eventThemes` — 🕯🪩🌲🌙🏖 etc.) | Picker renders color swatch + name; keys unchanged |
| Group default icon `👥` and emoji group icons | Render a monogram tile (group initial, plum bg, cream Fraunces letter, stripe bottom edge — same language as TitlePoster). Emoji picker UI is removed; photo/GIF remain. Server keeps accepting/storing emoji (old data), web just never renders it |
| `EventThumb` type-emoji fallback | TitlePoster monogram at thumb scale |
| Landing showcase chips (🎲📚🎤🍽) | Text-only chips |
| `🎨 Look / ✏️ Details` form section headers | `.section-h` labels: `LOOK`, `DETAILS` |

Also sweep `e2e/tests/*.spec.ts` for assertions that expect emoji strings (e.g. `toHaveText` with 🎉) and
update the expected text to match the new copy.

## 7. Copy rewrites (exact strings)

Voice: plain verbs, sentence case, specific beats clever, no exclamation marks, no emoji. A control says
exactly what happens.

| Location | Old | New |
|---|---|---|
| Guest invite banner | `You're invited 🎉` | `You're invited` |
| Landing/guest CTA | `Let's make a plan ⚡` | `Start the plan` |
| Landing hero | `Hangouts, handled.` | keep (it's good) |
| ProfileSetup | `Welcome 👋` | `Set up your profile` |
| Empty comments | `Nothing here yet - say hi 👋` | `No comments yet. Start the thread.` |
| Lock banner | `It's locked in 🎉` | `Locked in — {formatted date}` |
| Waitlist promotion email subject stays server-side (Phase 7) | `You're in 🎉` | `You're in` |
| Status pill | `POLLING` | `Deciding` |
| Status pill | `SCHEDULED` | `Locked in` |
| Recap email CTA (Phase 7) | `Drop a pic 📸` | `Add a photo from the night` |
| Nudge result toast | `Nudged N people 📣` | `Nudged N people` |
| RSVP note (new, under chips) | — | `{Host} gets a note when you answer.` |

Anything not listed: keep the words, drop the emoji, drop any `!`.

## 8. Page-by-page redlines

Work from the comp's phone mock; it shows Home-tile and EventPage language concretely.

- **EventPage** — hero gets stripe top rule + TitlePoster fallback; title in Fraunces; host row with avatar;
  status pill under title; meta rows with icons + amber time stamps; Who's in with stripe bar; RSVP card
  "Are you in?" with teal-selected chips; results grids get in-cell counts + BEST cell; comments with
  `COMMENTS · N` label; lock banner per §4. Host controls/edit forms: plain ghost/quiet buttons, section-h
  labels, no emoji.
- **Home** — tiles per comp (`.tile`): thumb (photo or monogram poster), Familjen 700 title, amber stamp
  date line, facepile. Filter chips: outline, selected = teal-on. "Today/soon" pill = amber `deciding` style.
  Series badge → `SERIES · N DATES` stamp.
- **NewEvent** — "What's the plan?" heading in Fraunces; segmented control and chips per new chip spec;
  helper text `--muted`; primary button "Create & get the link" → keep label, new button style.
- **Groups** — header name in Fraunces; monogram icon tile; streak stamp; invite card with `Ic.link`;
  member facepile card unchanged structurally.
- **Discover / Friends / Calendars / Profile** — token/component sweep, provider rows get text labels,
  theme toggle labels "Dark / Light" (no moon), availability legend uses CSS dots.
- **Landing** — same three screenshots (regenerate AFTER app revamp via `make marketing-shots`), Fraunces
  display hero, no emoji chips, plum stage background with grain (no clouds). Sync copy to
  `index.html` crawler block + `llms.txt` (CLAUDE.md invariant).
- **Emails + OG (final phase)** — `emails.go`: swap header gradient for solid plum + stripe rule, coral
  buttons with plum text, amber mono date lines; strip emoji from all email strings (`notifications.go`);
  `themeAccent` map syncs to new theme hues; OG cards (`ogimage.go`) get plum bg + stripe + cream type.

## 9. Verification loop (run at the end of EVERY phase)

```bash
# 1. Zero emoji + dingbats in web source (must print nothing):
grep -rnP '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2190}-\x{21FF}\x{2700}-\x{27BF}]' apps/web/src --include='*.tsx' --include='*.ts' | grep -v Icons.tsx
# 2. No glass / sky / forbidden gradients:
grep -n 'backdrop-filter\|--sky\|--cloud\|--glass' apps/web/src/styles.css
# 3. Types + units:
make test
# 4. Visual: run the stack and screenshot key pages, then LOOK at them:
make e2e   # will fail on visual diffs — expected during the revamp
make e2e-update && git diff --stat e2e/   # review every changed baseline image by eye
```

Screenshot self-critique checklist (open the new baselines / screenshots next to
`docs/design/house-lights-comp.html`):
- Backgrounds plum (or paper in light), never navy; no blur anywhere.
- Every visible date/time is an amber mono stamp; every status pill is mono uppercase with a dot.
- Primary buttons: plum text on coral. Selected chips: plum text on teal.
- The stripe appears ONLY on: hero top edge, who's-in bar, lock banner, thumb/monogram bottom edge.
- No emoji visible in any screenshot.
- Nothing wraps mid-button; nothing overflows on the 640px baselines.

## 10. Phases (run in order, one PR each)

Recommended executor per phase in parentheses — use the cheapest listed model.

1. **Foundations** (Sonnet): §2 tokens + §3 fonts + base element styles + `.btn/.chip/.pill/.card/.stamp/
   .section-h` respec + delete sky/glass. The whole app changes clothes at once; expect every visual
   baseline to diff. Done when §9 passes and a Home + EventPage screenshot matches the comp's language.
2. **Emoji eradication + Icons** (Haiku, it is mechanical): create `Icons.tsx`, apply §6 table + §7 copy,
   update e2e text assertions. Done when grep #1 prints nothing and `make e2e` behavior tests pass.
3. **EventPage** (Sonnet): §8 EventPage redlines incl. TitlePoster, stripe moments, heat-grid info design,
   lock banner, confetti deletion.
4. **Home + Groups + Discover + nav/tabbar** (Sonnet): tiles, monograms, facepiles, filters.
5. **Forms + remaining pages** (Sonnet): NewEvent, Profile, Friends, Calendars, ProfileSetup, theme-wash
   restyle of `.theme-*`.
6. **Landing + static pages** (Sonnet): landing, `vs/*` pages' shared styles, regenerate
   `make marketing-shots` + `make og-card`, sync crawler copy.
7. **Emails + OG images** (Sonnet): §8 last bullet; server-side strings lose emoji; verify with the
   existing email preview/E2E paths.
8. **Closeout** (any): update CLAUDE.md's look-and-feel paragraph (the "glass over a drifting sky" section)
   to describe House Lights, pointing at this file; final full `make e2e-update` review.

Per-phase kickoff prompt (paste to the executor):
> Read `docs/design/HOUSE-LIGHTS.md` fully, then open `docs/design/house-lights-comp.html` in a browser.
> Execute Phase N exactly as specified. Follow §1 (anti-slop contract) as hard rules and finish with the
> §9 verification loop, including looking at the screenshots yourself. Do not touch anything §1.11 forbids,
> and do not do work belonging to other phases.
