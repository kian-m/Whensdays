# Going public — launch readiness + first-100-pages plan

**Written Aug 2026, after the House Lights redesign and venue-pages V1–V6 shipped.**
This is the ordered list of what stands between the current build and confidently public, then the plan
for getting people. Work top to bottom; nothing here is speculative surface area — each item either
removes a launch risk or feeds the follower-activation funnel (page view → follow → digest → RSVP).

## A. Ship gate (technical, do before telling anyone)

1. **Push + deploy.** Everything landed locally on `app/scheduler`, unpushed by design. Push, let CI run
   the full suite (api/web/e2e jobs), deploy on green. Then click through prod: landing, sign-up,
   create-a-page, public page signed-out, follow, event RSVP as guest, one email (invite) on a real inbox.
2. **Style the Clerk surfaces.** `/sign-in`, `/sign-up`, and the account card render Clerk's default look —
   the one part of the product still off-brand, and it sits exactly on the "Create your page" conversion
   path. Use Clerk's `appearance` prop with House Lights tokens (plum bg, cream text, coral/plum primary,
   Familjen font variables). Small, high-leverage.
3. **Warm instance.** Flip Cloud Run `--min-instances` to 1 for launch (CLAUDE.md documents the tradeoff).
   A performer opening their own page to a cold start is a lost evangelist. Revisit cost after week 2.
4. **CSP: report-only → enforcing.** The report-only policy has been collecting real violations at
   `/api/csp-report`. Review the log; if quiet, flip the `_headers` policy to enforcing.
5. **Email deliverability.** Verify SPF/DKIM/DMARC on the sending domain in Resend, set
   `EMAIL_POSTAL_ADDRESS`, and send every template (invite, finalize, reminder, recap, follow digest) to
   Gmail + Apple Mail once — eyeball the House Lights rendering in real clients, not just HTML source.
6. **Klipy production key** (test key = 100/hr) and a pass over env: `CRON_KEY`, `GUEST_TOKEN_KEY`,
   `CALENDAR_TOKEN_KEY` rotation notes current; PostHog proxy host live.
7. **Public pages are crawlable assets — let them be found.** `/g/{id}` serves OG tags already; add listed
   public pages to `sitemap.xml` generation (or a static handful for the seed venues) and confirm
   `robots.txt` doesn't block `/g/`.
8. **PostHog dashboard.** Build the two funnels before there's traffic, so week-1 data is clean:
   follower activation (`page_viewed` → `follow_clicked` → digest send count → RSVP w/ digest UTM) and
   the classic loop (activation, invite→participant, K-factor, W4). All events exist (V6).

## B. Seed content (a public app that looks empty is worse than none)

1. **Dress the four venue-sync pages** (UCB, WGIS, We Improv, Rozco's): icon, description, correct city;
   run each sync so upcoming shows are live; confirm their public pages look like a real presence
   (follower counts render, past shows accumulate).
2. **Hand-make 3–5 pages with people you know** (the improv/stand-up/theater locals from the roadmap).
   Sit with them for 10 minutes each: create page, post next 2 events, put the follow link in their
   link-in-bio. These are the reference customers — screenshot their pages for marketing once real.
3. **Your own page.** Dogfood the whole loop weekly.

## C. Getting people (the 90-day motion)

The wedge stays comedy/improv/live-niche — people who perform on a schedule and have no good way to tell
followers. The pitch in one line: **"One link. Your shows land in your followers' calendars."**

1. **The open-mic circuit is the K-loop.** Open-mic audiences ARE performers. Rozco's Eastside Open Mic
   page + a QR flyer at the mic ("follow to know when it's on") converts attendees into followers, and
   some of those followers host their own mics/shows → new pages. Print one QR per seeded venue
   (the in-app page QR exists — `group-share-qr`).
2. **Performer outreach, 10 at a time.** Touring comedians / indie bands whose "shows" page is a pinned
   Instagram story. DM with their OWN page pre-made (create it, post their next 2 real shows from public
   info, transfer ownership — the cohost/admin mechanics support this). "Here's your page, it's already
   live, claim it" beats "sign up for my app."
3. **Fans need one reason: the calendar.** In every fan-facing surface, lead with "follow → it's on your
   calendar" (the webcal feed + RSVP-to-calendar already deliver this). That's the differentiator vs
   an Instagram follow.
4. **Measure weekly, one number per stage:** public-page views (are performers sharing?), follow
   conversion (is the page persuasive?), digest→RSVP (is the email valuable?), repeat attendance
   (is the loop real?). Kill or fix the weakest stage each week; add nothing new until digest→RSVP
   shows life.
5. **Hold the line on scope.** Things deliberately NOT now: `/u/{handle}` host pages, instant announce
   emails (digest first — flip the query window later if fans demand it), embeds/widgets for venue
   websites, verification/claiming flows, any Discover re-nav. Each becomes worth it only after ~50
   active pages.

## D. Polish backlog (post-launch, cheap, in priority order)

- Landing: retarget one product screenshot to a real public page with follower count (needs the dev-only
  route alias — flagged in Phase 6).
- 404 / not-found page in House Lights voice.
- The Profile availability card heading wraps awkwardly at 390px next to its buttons (flagged Phase 5;
  cosmetic).
- `docs/screenshots` + gallery refresh against the new design.
- Instant-announce option per page (query-window flip on the digest) once data argues for it.
