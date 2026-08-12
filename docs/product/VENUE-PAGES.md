# Venue & performer pages — the follow-based distribution playbook

**Goal:** shift user gathering onto **pages**: venues, touring comedians, indie bands, improv troupes.
A page is their public presence — followers see every listed event the page posts, choose to attend,
and it lands on their calendar. **Executor:** any Claude model; phases are sequential unless marked
parallel-safe. Read `CLAUDE.md` first — it documents every invariant this builds on.

## Decisions already made (do not relitigate)

1. **A page IS a group.** No new entity. A solo comedian's page is a group they own (possibly sole
   member); their booker/bandmates join via the invite link and get admin to post events. The public
   read (`public.go`) is entity-shaped so `/u/{handle}` host pages can exist LATER — do not build them now.
2. **Two links off one group** (shipped in the base commit): bare `/g/{id}` = public page (view +
   follow, no membership); `/g/{id}?invite=<token>` = join, token HMAC-signed + per-group revocable.
3. **Followers get a DAILY DIGEST email** of new events from pages they follow — not instant email,
   not feed-only. (User decision, Aug 2026.)
4. **Following requires an account.** The public page's Follow CTA routes through sign-up and completes
   the follow on return. No email-capture identity, no guest follows.
5. Followed events surface in the **main feed on Home** (user's words: "their main feed") — not a
   buried Discover tab.
6. Design language for all new UI: `docs/design/HOUSE-LIGHTS.md` — its §1 anti-slop contract is hard
   rules here too (zero emoji, stamp voice for dates, etc.). If a phase here runs before the redesign
   reaches a file, build with existing classes and let the redesign phase restyle.

## What already exists (build on it, never duplicate)

- `follows` with kinds host/topic/**group**; `FollowButton` (optimistic, guest-gated); follow state on
  group + event responses. `GET /api/feed?scope=following` returns followed entities' upcoming listed
  events (`ListFollowedEvents`, deduped/ranked via `mergeCandidates`).
- `events.listed` (default true on create, "Show to my followers" checkboxes, `PUT /api/events/{id}/listed`).
- Group admin roles: owner/admins create the group's events — that IS "multiple members post to the page".
- Public page: `GET /api/public/groups/{id}` (unauthenticated, rate-limited) + `GroupPublicView` +
  OG unfurl split (invite link promises a seat, bare link promises a look).
- Attend → calendar: RSVP overlays availability as booked; per-event .ics + Google link; live
  `webcal` feed (`/api/feed.ics`) already includes the user's events.
- Email plumbing: `internal/notify`, branded `renderEmail`, claim-before-send idempotency patterns
  (`cron_run_claims`), per-recipient mute + HMAC unsubscribe, UTM tagging, the daily 2pm-Pacific cron.
- Venue-sync bots (UCB/WGIS/We Improv/Rozco's) already materialize real venue schedules into groups —
  these groups become the first real venue pages with zero content work.

## Phases

### V1 — Land the base (Sonnet) — status: verify + commit
The uncommitted public-page/invite-token work. `make test` already passes. Run the hermetic E2E
(`make e2e`; visual baselines may diff if the redesign already merged — behavior assertions must pass),
fix only what's broken, commit as one commit: "Group pages: public /g/{id} + signed join links".

### V2 — Following in the main feed (Sonnet)
Home gains the followed-events surface:
- Server: dashboard response (`GET /api/events`) unchanged; web calls `GET /api/feed?scope=following`
  alongside it (only when the user follows ≥1 thing — expose `follow_count` cheaply, e.g. on the
  dashboard response, to gate the fetch).
- Home shows a **"From pages you follow"** section under the user's own tiles (or a "Following" filter
  chip alongside all/upcoming/hosting/attending — pick whichever reads cleaner with the tile layout,
  but followed events must be visible on the default view, not only behind the chip: show the next 3
  with a "See all" that applies the chip).
- Followed tiles reuse the standard tile + a small page-name attribution line ("via {group name}", links
  to the page). RSVP from the event page works already (link = capability).
- Empty state when following nothing: one quiet line linking to Discover, nothing louder.
- E2E: follow a group → its listed event appears on Home; unfollow → gone.

### V3 — The daily follow digest (Sonnet, parallel-safe with V2 — server files only)
One email per follower per day listing new events from pages they follow. Ride the existing daily cron
(`handleCronReminders` chain), same idempotency religion as every other send:
- Query: listed, non-cancelled, non-draft, upcoming events **created in the last 24h** whose group (or
  host, for host-follows) is followed by the recipient; recipient must have an email; skip events the
  recipient already RSVP'd to; skip events created by the recipient.
- Idempotency: claim `('follow_digest', run_day)` in `cron_run_claims` before building sends (global
  claim + created_at window = at-most-once, the house tradeoff).
- One email per recipient: subject "New from pages you follow" (1 event: "{Page}: {Title}"); each row =
  cover thumb if https, title, amber date line, page name, **one-tap RSVP links** (existing `rsvp|`
  pattern) + View. Footer: per-event mute links as usual + "Following {Page} — unfollow" via a new
  HMAC namespace `follow|<uid>|<kind>|<value>` → unauthenticated `GET /api/follows/unsubscribe?token=`
  rendering the same script-free confirm page as mute. UTM campaign `email_follow_digest`.
- Costs: bounded by follower counts; no new cron schedule (rides the daily job). Unit-test the
  collapse/build pure functions like `collapseActivity`.

### V4 — Page-quality pass on /g/{id} (Sonnet, after V1+V2)
Make the public page worth being someone's ONLY web presence:
- Follower count on the page (public, alongside member count) + on the member view.
- Members get a **"Share your page"** card: the bare link + QR (reuse QRButton) — clearly separated
  from the members-only invite link card. Copy: "Anyone with this link can see your events and follow you."
- Page header: name, icon/monogram, description, Follow button, upcoming listed events; past listed
  events collapse into a "Past" section (social proof for venues) — extend `public.go` with a bounded
  recent-past list (limit ~10, listed only).
- The "unlisted events" hint for admins (exists) stays — it's how a page owner notices their events
  aren't reaching followers; wire it to `PUT /api/events/{id}/listed`.
- OG card for the bare link should say follow, not join (done in base; verify copy).

### V5 — Page onboarding + creation intent (Sonnet)
- **Close the landing CTA loop (now urgent — the landing ships "Create your page" → /sign-up):** the CTA
  should carry `?intent=page` (or equivalent) through the sign-up redirect so the first signed-in screen
  routes into create-a-page (group create pre-tuned to page defaults below) instead of a generic Home.
  Use the same mechanism the guest-login `?redirect_url=` flow already uses (same-origin only).
- Group creation gains an optional purpose step: "Friends" vs "Venue / performer page" — SAME entity,
  the choice only tunes defaults and copy (a page defaults `listed` checked, shows the share-your-page
  card first, description placeholder "Tell people what you do and where"). Store nothing new server-side
  unless a single `groups.kind` text column ('friends'|'page', default 'friends') proves necessary for
  copy — prefer zero schema.
- Landing/marketing: DONE EARLIER THAN PLANNED — the user re-scoped the landing (Aug 2026) to LEAD with
  the pages/following pitch ("Build a following. Fill the room.", primary CTA "Create your page" →
  /sign-up, friends-planning demoted to a secondary line into the guest /start flow). Shipped in House
  Lights Phase 6. V5's landing work is therefore only: point the "Create your page" path at the real
  onboarding below once it exists.
- Seed list: the four venue-sync groups + the user's improv/standup contacts get their pages dressed
  (icon, description) — manual, not code.

### V7 — Performers on events (follow a person, see every event they're on)
**The vision (user, Aug 2026):** follow a person and see any event they are IN — events carry a lineup of
performers, and anyone following a performer sees the events they're attached to, regardless of who hosts.
Decisions (made, do not relitigate):
- **No new follow kind.** `follows.kind='host'` already means "follow this person"; it now surfaces events
  they host OR are a confirmed performer on. One follow, one meaning.
- **Schema:** `event_performers(event_id, user_id, status 'pending'|'confirmed', added_by, created_at,
  PK(event_id, user_id))` — migration 0046. Performers are real users added by handle (like cohosts).
  Non-user "special guests" stay in the event description; no free-text rows.
- **Consent gates distribution (anti-hijack):** display on the event page is immediate (the host's own
  claim about their lineup), but feed + digest surfacing counts ONLY `confirmed` rows — otherwise anyone
  could attach a well-known performer and blast their followers. The performer gets an email ("{Host}
  added you to the lineup of {Event}") with one-tap Confirm / Remove links (HMAC namespace `perf|`, same
  pattern as `rsvp|`, script-free confirmation page), plus an in-app banner on the event page when the
  viewer is a pending performer. Performers can remove themselves anytime; managers add/remove
  (manager-gated like cohosts); listed-only invariant applies as everywhere.
- **Surfacing:** extend `ListFollowedEvents` (feed) and `ListNewFollowedEvents` (digest) with a third arm —
  events having a confirmed performer the recipient follows (kind='host'). Dedupe already exists
  (mergeCandidates / DISTINCT ON); attribution prefers group > performer > host, and a performer-attributed
  row reads "with {performer name}".
- **Web:** EventPage gains a "Lineup" card visible to everyone (avatar, name, FollowButton with
  source="lineup", pending pill visible to managers + the performer, remove for managers/self, add-by-handle
  for managers — mirror the cohost manager UI); pending-performer banner with Confirm/Remove; House Lights
  §1 rules throughout.
- **E2E:** add performer → pending (not in feed/digest query) → confirm → appears in follower's Home feed
  with "with {name}" attribution → self-remove → gone. Plus the token round-trip unit test (`perf|`
  namespace isolation in guests_test.go style).

### V6 — Instrumentation (Haiku) — status: instrumented
PostHog events for the follower activation funnel. Page view → follow → digest sent → RSVP.

Events added:
- Web `page_viewed` (on GroupPublicView mount): props group_id, signed_out boolean
- Web `follow_clicked` (FollowButton): props kind, value, source
- Web `guest_signup_clicked` (existing event, enhanced): source prop = "public_page" (group public-page follow CTA), "landing_create_page" (landing "Create your page" button), or existing values
- Server `public_page_served` (handleGroupPublicPage): group_id, signed_in boolean (captured for authenticated users only)
- Digest email tracking (existing): `campaignURL(..., "follow_digest")` = utm_campaign=email_follow_digest; one-tap RSVP links in digest via `s.rsvpLink()`. RSVP-from-digest is already attributable via the existing rsvp-link flow analytics (unsigned token clicks hit `/api/events/{id}/rsvp-link` → browser redirect to login → `POST /api/events/{id}/rsvp` with existing RSVP analytics).

## Sequencing with the House Lights redesign

Two tracks share web files. Order of landings on `app/scheduler`:
1. V1 commit (base) → 2. redesign Phase 1 (tokens; separate worktree branch, merge) → 3. redesign
Phase 2 (emoji) → then alternate: V2/V4 land between redesign phases 3–5 with rebases; V3 (Go only)
lands anytime; V5/V6 after redesign Phase 6. One PR per phase, every PR runs the House Lights §9
verification loop once Phase 1 has merged.
