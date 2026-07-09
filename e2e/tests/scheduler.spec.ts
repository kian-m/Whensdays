import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { readFileSync } from "fs";

const DEV_AUTH = process.env.E2E_AUTH_MODE === "dev";

// Feature: the scheduler ("Whensdays"). Asserts behavior (create an event,
// respond as a guest, host sees the answers) AND a visual baseline of the create
// form. In prod-shaped runs it signs in via Clerk; in hermetic dev runs auth is
// stubbed so no Clerk is needed. Idempotent: the dev DB persists across the
// two-pass (baseline + assert) run, so we tolerate pre-existing profile/data.
test.describe("scheduler", () => {
  // These tests share the dev stub user (demo-user) and its profile, so run them
  // in order rather than racing two workers over the same first-run setup.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    if (DEV_AUTH) return;
    await setupClerkTestingToken({ page });
    await page.goto("/");
    await clerk.signIn({
      page,
      signInParams: {
        strategy: "password",
        identifier: process.env.E2E_CLERK_USER_USERNAME!,
        password: process.env.E2E_CLERK_USER_PASSWORD!,
      },
    });
  });

  async function ensureProfile(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.waitForSelector('[data-testid="setup-name"], [data-testid="new-event"]');
    if (await page.getByTestId("setup-name").isVisible()) {
      await page.getByTestId("setup-name").fill("Demo Host");
      await page.getByTestId("setup-handle").fill("demohost");
      await page.getByTestId("setup-save").click();
    }
    await expect(page.getByTestId("new-event")).toBeVisible();
  }

  test("create an event, respond as a guest, host sees preferences", async ({ page }) => {
    await ensureProfile(page);

    const title = `Dinner ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-01T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();

    // Lands on the event page in the host view (share link is host-only).
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByTestId("share-link")).toBeVisible();

    // Preview as a guest: RSVP, then answer the one-at-a-time preference Qs
    // (they live off the critical path now - expand the optional section).
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await page.getByTestId("pref-summary").click();
    await page.getByTestId("pref-input").fill("Vegetarian");
    await page.getByTestId("pref-next").click();
    await page.getByTestId("pref-input").fill("Italian");
    await page.getByTestId("pref-save").click();

    // Back in the host view, the guest's answer is summarized.
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByText("Vegetarian")).toBeVisible();

    // The dashboard tile now carries an avatar stack: the RSVP shows as a
    // face (initial fallback) with the going tally.
    await page.goto("/");
    const row = page.getByTestId("event-row").filter({ hasText: title }).first();
    await expect(row.getByTestId("facepile")).toBeVisible();
    await expect(row.getByTestId("facepile")).toContainText("going");
  });

  test("create a general-availability poll and respond", async ({ page }) => {
    await ensureProfile(page);

    const title = `Hangout ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-general").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();

    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Preview as a guest: pick a month and a per-day time cell (Sat evening), save.
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await page.getByTestId("gp-month-0").click();
    await page.getByTestId("gp-cell-6-evening").click();
    await page.getByTestId("save-general").click();

    // Back in the host view, the aggregate reflects the pick.
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByText("Group availability")).toBeVisible();
    // Flipped grid (days vertical, times horizontal): the Saturday-evening cell
    // carries the single vote.
    await expect(page.getByTestId("grg-pick-6-evening")).toHaveText("1");

    // Per-guest view: a responder dot appears; selecting it highlights that
    // person's picks, and "show everyone" clears the selection.
    await expect(page.getByTestId("responder-dots")).toBeVisible();
    await page.getByTestId("responder-dots").getByRole("button").first().click();
    await expect(page.getByTestId("responder-dots")).toContainText("Highlighting");
    await page.getByTestId("responders-all").click();
    await expect(page.getByTestId("responder-dots")).toContainText("Tap someone");
  });

  test("performance preset types + deletable custom types", async ({ page }) => {
    await ensureProfile(page);
    await page.getByTestId("new-event").click();
    // New presets for the local-scene crowd.
    await expect(page.getByTestId("type-show")).toBeVisible();
    await expect(page.getByTestId("type-practice")).toBeVisible();
    await expect(page.getByTestId("type-openmic")).toBeVisible();
    // Save a custom type, then delete it via the chip's ✕.
    await page.getByTestId("type-add").click();
    await page.getByTestId("newtype-name").fill("Jam Sesh");
    await page.getByTestId("newtype-save").click();
    await page.getByTestId("event-title").fill(`Custom del ${test.info().testId}`);
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-02T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(`Custom del ${test.info().testId}`);
    // The saved chip is offered on the next create - delete it.
    await page.goto("/new");
    await expect(page.getByTestId("custom-jam sesh")).toBeVisible();
    await page.getByTestId("custom-del-jam sesh").click();
    await expect(page.getByTestId("custom-jam sesh")).toHaveCount(0);
  });

  test("hero edit-in-place: cover photo + backdrop theme", async ({ page }) => {
    await ensureProfile(page);
    const title = `Cover ${test.info().testId}`;
    await page.goto("/quick");
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-when").fill("2026-10-09T19:00");
    await page.getByTestId("quick-create").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // The Edit affordance lives on the hero card and flips it in place.
    await page.getByTestId("edit-event-open").click();
    await expect(page.getByTestId("hero-edit")).toBeVisible();
    // Upload a square cover (client-resized like avatars).
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.getByTestId("cover-file").setInputFiles({
      name: "cover.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
    });
    // The crop dialog lets the host pick which square of the photo to use.
    await expect(page.getByTestId("crop-modal")).toBeVisible();
    await page.getByTestId("crop-save").click();
    await expect(page.getByTestId("crop-modal")).toHaveCount(0);
    await expect(page.getByTestId("event-cover")).toHaveAttribute("src", /^data:image\//);
    // Pick a backdrop theme - the WHOLE page reflects it live, before saving.
    await page.getByTestId("theme-party").click();
    await expect(page.locator(".event-theme.theme-party")).toBeVisible();
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-edit")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("event-cover")).toHaveAttribute("src", /^data:image\//);
    await expect(page.locator(".event-theme.theme-party")).toBeVisible();
    // The per-event social card (og:image) serves a composited PNG, and the
    // unfurl page points at it.
    // After the reload, the OG shell bounced /e/{id} to the SPA alias /ev/{id} -
    // parse the uuid itself rather than assuming the prefix.
    const evId = page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0];
    const og = await page.request.get(`/api/events/${evId}/og.png`);
    expect(og.status()).toBe(200);
    expect(og.headers()["content-type"]).toContain("image/png");
    const shell = await page.request.get(`/e/${evId}`);
    expect(await shell.text()).toContain(`/api/events/${evId}/og.png`);

    // The cover is now the tile's main visual on the dashboard, and the theme
    // dramatically restyles the whole tile (accent wash + glow border).
    await page.goto("/");
    const covRow = page.getByTestId("event-row").filter({ hasText: title }).first();
    await expect(covRow.getByTestId("event-thumb")).toHaveAttribute("src", /^data:image\//);
    await expect(covRow).toHaveClass(/theme-tile/);
    await expect(covRow).toHaveClass(/theme-party/);
    await covRow.click();
    // Clean up the theme+cover so other shared-user tests see a plain hero, and
    // reschedule - the start time stays editable after the event has a time.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("cover-remove").click();
    await page.getByTestId("theme-none").click();
    await expect(page.getByTestId("edit-time")).toBeVisible();
    await page.getByTestId("edit-time").fill("2026-10-11T20:30");
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-edit")).toHaveCount(0);
    // The new date shows in the event's timezone (E2E pins tz=UTC).
    await expect(page.getByText(/October 11/)).toBeVisible();
  });

  test("plan the next one: ?again= prefills the wizard from a past event", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "again1", "Again One", "again1");
    const title = `Round1 ${test.info().testId}-${Date.now()}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-12-01T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0];

    // The recap email's "Plan the next one" link lands here - prefilled.
    await page.goto(`/new?again=${id}`);
    await expect(page.getByTestId("event-title")).toHaveValue(title);
  });

  test("irregular series: multiple picked dates + host re-poll entry", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "multi1", "Multi One", "multi1");
    const title = `Jam ${test.info().testId}-${Date.now()}`;
    const dt = (days: number) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
    };
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill(dt(2));
    // Add a second, non-pattern date (different weekday) → an irregular series.
    await page.getByTestId("add-date").click();
    await page.getByTestId("more-date-0").fill(dt(5));
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Both dates form one series ("1 of 2", picked-dates recurrence) - and the
    // hero card lists EVERY date, not just this occurrence's.
    await expect(page.getByTestId("series")).toContainText("1 of 2");
    await expect(page.getByTestId("series")).toContainText("on picked dates");
    await expect(page.getByTestId("hero-dates").locator("div")).toHaveCount(2);

    // Every date is editable from the edit form: retime the sibling occurrence.
    const sibWhen = dt(7);
    const sibLabel = new Date(sibWhen).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-time-sib-0").fill(sibWhen);
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-dates")).toContainText(sibLabel);
    // Series-wide editing: retitle with "apply to all dates" → the sibling
    // occurrence picks up the new title (its own date untouched).
    const newTitle = `${title} v2`;
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-title").fill(newTitle);
    await page.getByTestId("edit-apply-series").check();
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("event-title")).toHaveText(newTitle);
    await page.getByTestId("series-occ-1").click();
    await expect(page.getByTestId("event-title")).toHaveText(newTitle);
    await expect(page.getByTestId("series")).toContainText("2 of 2");

    // The last date is within 3 weeks → the host sees the re-poll entry, which
    // opens a prefilled poll that will re-invite everyone.
    await page.getByTestId("series-repoll").click();
    await expect(page.getByTestId("event-title")).toHaveValue(newTitle);
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await expect(page.getByTestId("sched-poll")).toHaveClass(/on/);
  });

  test("edit grows a lone event into a series by adding dates", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for an isolated user");
    await ensureUser(page, "grower", "Grow Er", "grower");
    const title = `Growable ${test.info().testId}-${Date.now()}`;
    const dt = (days: number) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
    };
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill(dt(3));
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByTestId("hero-dates")).toHaveCount(0); // one date - no series list

    // "+ Add another date" in the edit form turns it into a 2-date series.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-add-date").click();
    await page.getByTestId("edit-add-date-0").fill(dt(6));
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-dates").locator("div")).toHaveCount(2);
    await expect(page.getByTestId("series")).toContainText("1 of 2");

    // The invite card offers a styled QR code: restyle + recolor live.
    await page.getByTestId("qr-open").click();
    await expect(page.getByTestId("qr-img")).toHaveAttribute("src", /^data:image\/png/);
    const before = await page.getByTestId("qr-img").getAttribute("src");
    await page.getByTestId("qr-style-dots").click();
    await page.getByTestId("qr-color-d3572f").click();
    const after = await page.getByTestId("qr-img").getAttribute("src");
    expect(after).toMatch(/^data:image\/png/);
    expect(after).not.toBe(before); // restyle actually redrew it
    await expect(page.getByTestId("qr-download")).toHaveAttribute("href", /^data:image\/png/);
    await page.getByTestId("qr-close").click();
    await expect(page.getByTestId("qr-modal")).toHaveCount(0);
  });

  test("slide-to-paint availability; poll picks sync to main availability", async ({ page }) => {
    test.skip(!DEV_AUTH, "asserts via dev-header API reads");
    await ensureUser(page, "slider", "Slide R", "slider");

    // Drag across three cells on the profile availability grid - one gesture
    // paints them all (When2meet-style).
    await page.goto("/profile");
    await page.getByTestId("avail-edit").click();
    await expect(page.getByTestId("availability-grid")).toBeVisible();
    await page.getByTestId("avail-cell-0-morning").hover();
    await page.mouse.down();
    await page.getByTestId("avail-cell-0-afternoon").hover();
    await page.getByTestId("avail-cell-0-evening").hover();
    await page.mouse.up();
    for (const dp of ["morning", "afternoon", "evening"]) {
      await expect(page.getByTestId(`avail-cell-0-${dp}`)).toHaveClass(/\bon\b/);
    }

    // Poll picks flow back into main availability: vote two week-scope cells,
    // then the SAME cells show as free days on /api/availability/days.
    await page.goto("/quick");
    const title = `Sync ${test.info().testId}-${Date.now()}`;
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-mode-avail").click(); // week-scope poll
    await page.getByTestId("quick-create").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().split("/e/")[1];

    // The voting grid is guest-side (the host sees results), so vote via the
    // API as a second user - the sync itself is server-side.
    const day = new Date(Date.now() + 2 * 24 * 3600_000);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const d = `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}`;
    const synced = await page.evaluate(async ({ eid, d }) => {
      const h = { "Content-Type": "application/json", "X-Dev-User": "slidee" };
      await fetch("/api/profile", { method: "PUT", headers: h, body: JSON.stringify({ display_name: "Slide E", handle: "slidee" }) });
      await fetch(`/api/events/${eid}/general-votes`, {
        method: "POST", headers: h,
        body: JSON.stringify({ day_slots: [{ day: d, daypart: "evening" }, { day: d, daypart: "night" }] }),
      });
      const res = await fetch("/api/availability/days", { headers: { "X-Dev-User": "slidee" } });
      const b = await res.json();
      return (b.days ?? []).filter((x: { day: string }) => x.day.startsWith(d))
        .map((x: { daypart: string; status?: string }) => `${x.daypart}:${x.status ?? "free"}`);
    }, { eid: id, d });
    expect(synced).toContain("evening:free");
    expect(synced).toContain("night:free");
  });

  test("capacity: full events waitlist, freed spots auto-promote", async ({ page }) => {
    test.skip(!DEV_AUTH, "drives extra users via dev headers");
    await ensureUser(page, "caphost", "Cap Host", "caphost");
    const title = `Capped ${test.info().testId}-${Date.now()}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    const d = new Date(Date.now() + 3 * 24 * 3600_000);
    const p2 = (n: number) => String(n).padStart(2, "0");
    await page.getByTestId("fixed-time").fill(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T19:00`);
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("event-capacity").fill("1");
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().split("/e/")[1];

    // A takes the only spot; B lands on the waitlist; A stepping back promotes B.
    const states = await page.evaluate(async (eid) => {
      const rsvp = async (u: string, r: string) => {
        const h = { "Content-Type": "application/json", "X-Dev-User": u };
        await fetch("/api/profile", { method: "PUT", headers: h, body: JSON.stringify({ display_name: u, handle: u }) });
        const res = await fetch(`/api/events/${eid}/rsvp`, { method: "POST", headers: h, body: JSON.stringify({ rsvp: r }) });
        return (await res.json()).rsvp;
      };
      const a1 = await rsvp("capa", "going");
      const b1 = await rsvp("capb", "going");
      const a2 = await rsvp("capa", "declined");
      const detail = await (await fetch(`/api/events/${eid}`, { headers: { "X-Dev-User": "caphost" } })).json();
      const b2 = detail.attendees.find((x: { user_id: string }) => x.user_id === "capb")?.rsvp;
      return { a1, b1, a2, b2 };
    }, id);
    expect(states.a1).toBe("going");
    expect(states.b1).toBe("waitlist");   // full -> waitlisted
    expect(states.a2).toBe("declined");
    expect(states.b2).toBe("going");      // spot freed -> promoted

    // The promoted guest shows under Going on the guest list.
    await page.reload();
    await expect(page.getByTestId("guests")).toContainText("capb");
  });

  test("poll deadline: shows the close date and stops votes after it", async ({ page }) => {
    test.skip(!DEV_AUTH, "backdates the deadline (dev-exempt validation)");
    await ensureUser(page, "dlhost", "Deadline Host", "dlhost");
    const title = `Deadline ${test.info().testId}-${Date.now()}`;
    const dt = (days: number) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T18:00`;
    };
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-general").click();
    await page.getByTestId("poll-deadline").fill(dt(2));
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().split("/e/")[1];

    // The hero advertises the close date while the poll is open.
    await expect(page.getByText(/poll closes/i)).toBeVisible();

    // Prefilled chat shares carry the title + invite link.
    const wa = await page.getByTestId("share-whatsapp").getAttribute("href");
    expect(wa).toContain("wa.me");
    expect(wa).toContain(encodeURIComponent(`/e/${id}`));
    await expect(page.getByTestId("share-sms")).toHaveAttribute("href", /^sms:/);

    // Host moves the deadline into the past (dev-exempt) - the poll closes.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-deadline").fill(dt(-1));
    await page.getByTestId("edit-save").click();
    await expect(page.getByText("Poll closed - time coming soon")).toBeVisible();

    // Votes bounce off a closed poll (server-enforced, 409).
    const status = await page.evaluate(async (eid) => {
      const h = { "Content-Type": "application/json", "X-Dev-User": "dlguest" };
      await fetch("/api/profile", { method: "PUT", headers: h, body: JSON.stringify({ display_name: "DL Guest", handle: "dlguest" }) });
      const r = await fetch(`/api/events/${eid}/general-votes`, { method: "POST", headers: h, body: JSON.stringify({ months: [], slots: [] }) });
      return r.status;
    }, id);
    expect(status).toBe(409);
  });

  test("poll options rank against ALL attendees' availability", async ({ page, browser }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "fit1", "Fit Host", "fit1");
    const title = `Fit ${test.info().testId}-${Date.now()}`;
    const dt = (days: number, time: string) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${time}`;
    };
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-poll").click();
    await page.getByTestId("poll-option-0").fill(dt(1, "19:00")); // tomorrow evening
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0];

    // A second user marks tomorrow evening FREE in their availability, then
    // joins the event (RSVP makes them an attendee).
    const ctx = await browser.newContext();
    try {
      const g = await ctx.newPage();
      await ensureUser(g, "fit2", "Fit Guest", "fit2");
      await g.goto("/profile");
      await g.getByTestId("avail-edit").click();
      const fitCell = g.getByTestId("avail-cell-1-evening");
      if (!((await fitCell.getAttribute("class")) ?? "").includes("on")) {
        await fitCell.click(); // idempotent across gate passes (shared DB)
      }
      await g.getByTestId("save-availability").click();
      await expect(g.getByText("Availability saved ✓")).toBeVisible();
      await g.goto(`/e/${id}`);
      const rsvpDone = g.waitForResponse((r) => r.url().includes("/rsvp") && r.ok());
      await g.getByTestId("rsvp-going").click();
      await rsvpDone;
    } finally {
      await ctx.close();
    }

    // The host's ranking now shows the group fit for that slot.
    await page.reload();
    await expect(page.getByTestId("fit-0")).toContainText("1 free");
  });

  test("group streak shows consecutive months of events", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "streak1", "Streak One", "streak1");
    const uniq = `${Date.now()}`;
    await page.goto("/groups");
    await page.getByTestId("group-name").fill(`Streak Crew ${uniq}`);
    await page.getByTestId("group-create").click();
    await page.getByTestId("group-row").filter({ hasText: uniq }).click();
    await expect(page.getByTestId("group-title")).toContainText("Streak Crew");
    const gid = page.url().split("/g/")[1];
    const monthDate = (offsetMonths: number) => {
      const d = new Date();
      d.setMonth(d.getMonth() + offsetMonths, 15); // mid-month avoids rollover
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
    };
    for (const [i, when] of [monthDate(-1), monthDate(0)].entries()) {
      await page.goto(`/new?group=${gid}`);
      await page.getByTestId("event-title").fill(`Streak ev${i} ${uniq}`);
      await page.getByTestId("wiz-next").click();
      await page.getByTestId("wiz-next").click();
      await page.getByTestId("sched-fixed").click();
      await page.getByTestId("fixed-time").fill(when);
      await page.getByTestId("wiz-next").click();
      await page.getByTestId("create-event").click();
      await page.getByTestId("event-title").waitFor();
    }
    await page.goto(`/g/${gid}`);
    await expect(page.getByTestId("group-streak")).toContainText("2-month streak");
  });

  test("events can carry an end time", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "endt1", "End Time", "endt1");
    const title = `Ends ${test.info().testId}-${Date.now()}`;
    const dt = (days: number, time: string) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${time}`;
    };
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill(dt(3, "19:00"));
    await page.getByTestId("fixed-end").fill(dt(3, "22:00"));
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // Hero shows the range (start – end).
    await expect(page.getByText(/– 10:00 PM/)).toBeVisible();
    // Editable: push the end later.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-end").fill(dt(3, "23:00"));
    await page.getByTestId("edit-save").click();
    await expect(page.getByText(/– 11:00 PM/)).toBeVisible();
  });

  test("pure availability voters (no RSVP) show their real name", async ({ page, browser }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "vn1", "Voter Host", "vn1");
    const title = `Voters ${test.info().testId}-${Date.now()}`;
    await page.goto("/quick");
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-mode-avail").click();
    await page.getByTestId("quick-create").click();
    await page.getByTestId("event-title").waitFor();
    const id = page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0];

    // Second user fills availability WITHOUT ever RSVPing.
    const ctx = await browser.newContext();
    try {
      const g = await ctx.newPage();
      await ensureUser(g, "vn2", "Norah NoRsvp", "vn2");
      await g.goto(`/e/${id}`);
      await g.getByTestId("gpw-cell-1-evening").click();
      const saved = g.waitForResponse((r) => r.url().includes("general-votes") && r.ok());
      await g.getByTestId("save-general").click();
      await saved;
    } finally {
      await ctx.close();
    }

    // Host sees the responder's real name on the dot, not "Guest".
    await page.reload();
    await expect(page.getByTestId("responder-dots")).toBeVisible();
    await expect(page.getByTestId("responder-vn2")).toHaveAttribute("title", "Norah NoRsvp");
  });

  test("past events leave All and live under the Past filter", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "past1", "Past One", "past1");
    const uniq = `${test.info().testId}-${Date.now()}`;
    const dt = (days: number) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
    };
    const mk = async (title: string, when: string) => {
      await page.goto("/quick");
      await page.getByTestId("quick-title").fill(title);
      await page.getByTestId("quick-when").fill(when);
      await page.getByTestId("quick-create").click();
      await page.getByTestId("event-title").waitFor();
    };
    await mk(`Old ${uniq}`, dt(-3));   // three days ago -> past
    await mk(`Soon ${uniq}`, dt(3));   // in three days -> active

    await page.goto("/");
    // All shows the upcoming one but NOT the past one.
    await expect(page.getByTestId("event-row").filter({ hasText: `Soon ${uniq}` })).toBeVisible();
    await expect(page.getByTestId("event-row").filter({ hasText: `Old ${uniq}` })).toHaveCount(0);
    // The Past filter shows it.
    await page.getByTestId("filter-past").click();
    await expect(page.getByTestId("event-row").filter({ hasText: `Old ${uniq}` })).toBeVisible();
    await expect(page.getByTestId("event-row").filter({ hasText: `Soon ${uniq}` })).toHaveCount(0);
  });

  test("mute event notifications toggles and persists", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "mute1", "Mute One", "mute1");
    const title = `Mute ${test.info().testId}-${Date.now()}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-11-20T18:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Default: subscribed. Mute, then confirm it sticks across a reload.
    const mute = page.getByTestId("mute-toggle");
    await expect(mute).toContainText("Mute notifications");
    await mute.click();
    await expect(mute).toContainText("muted");
    await page.reload();
    await expect(page.getByTestId("mute-toggle")).toContainText("muted");
    // Un-mute again (leave a clean state for shared-DB idempotency).
    await page.getByTestId("mute-toggle").click();
    await expect(page.getByTestId("mute-toggle")).toContainText("Mute notifications");
  });

  test("address type-ahead, directions link, and add-friend from RSVPs", async ({ page, browser }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "wc1", "W C One", "wc1");
    const title = `Party ${test.info().testId}-${Date.now()}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    // Address type-ahead: GEO_MODE=stub serves fixed suggestions. Letters-first
    // input (a venue name) gets NO suggestions; digits-first (a street address) does.
    await page.getByTestId("event-address").fill("main street");
    await page.waitForTimeout(600);
    await expect(page.getByTestId("addr-menu")).toHaveCount(0);
    await page.getByTestId("event-address").fill("123 main");
    await expect(page.getByTestId("addr-menu")).toBeVisible();
    await page.getByTestId("addr-opt-0").click();
    await expect(page.getByTestId("event-address")).toHaveValue(/Brooklyn/);
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-10-15T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)![0];

    // The address offers both map apps (no universal "default map app" link exists).
    const dir = page.getByTestId("directions-link");
    await expect(dir).toBeVisible();
    expect(await dir.getAttribute("href")).toContain("google.com/maps");
    const apple = page.getByTestId("directions-apple");
    await expect(apple).toBeVisible();
    expect(await apple.getAttribute("href")).toContain("maps.apple.com");

    // A second real user RSVPs going.
    const ctx = await browser.newContext();
    try {
      const wc2 = await ctx.newPage();
      await ensureUser(wc2, "wc2", "W C Two", "wc2");
      await wc2.goto(`/e/${id}`);
      await wc2.getByTestId("rsvp-going").click();

      // Host sees them under "Who's coming → Going" and can add them as a friend.
      await page.goto(`/e/${id}`);
      await expect(page.getByTestId("rsvp-group-going")).toContainText("@wc2");
      const addBtn = page.getByTestId("add-friend-wc2");
      if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
      await expect(page.getByTestId("rsvp-group-going")).toContainText(/Requested|Friends/);
    } finally {
      await ctx.close();
    }
  });

  test("create form visual baseline", async ({ page }) => {
    await ensureProfile(page);
    await page.getByTestId("new-event").click();
    // Deterministic state: step 1 (What) with a known type selected, title
    // empty, and nothing focused (a focus ring would be pass-dependent).
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("event-title").fill("");
    await page.getByTestId("event-title").blur();
    await expect(page.locator("form")).toHaveScreenshot("new-event-form.png");
  });

  test("export a confirmed event to calendar (.ics + google link)", async ({ page }) => {
    await ensureProfile(page);

    const title = `Calendar ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-01T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // The export block shows on confirmed (scheduled) events.
    const block = page.getByTestId("add-to-calendar");
    await expect(block).toBeVisible();

    // Google link is a client-built TEMPLATE url carrying the title + a time range.
    const href = await page.getByTestId("add-google").getAttribute("href");
    expect(href).toContain("calendar.google.com/calendar/render");
    expect(href).toContain("action=TEMPLATE");
    expect(href).toContain("text=Calendar");
    expect(href).toMatch(/dates=20260801T\d{6}Z%2F20260801T\d{6}Z/);
    expect(href).toContain("RSVP"); // details deep-link back to the event

    // Apple/native path: a plain (auth-free) .ics link phones can open directly.
    const appleHref = await page.getByTestId("add-apple").getAttribute("href");
    expect(appleHref).toContain("/calendar.ics");

    // Download the .ics and assert it is a valid single-event VCALENDAR.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("download-ics").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.ics$/);
    const ics = readFileSync(await download.path(), "utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain(`SUMMARY:${title}`);
    expect(ics).toContain("DTSTART:20260801T");
    // The invite link rides along (URL + DESCRIPTION) so there's a way back.
    expect(ics).toMatch(/URL:.*\/e\//);
    expect(ics).toContain("RSVP & details:");
    // No pixel snapshot: text-content cards render 1px-height-unstable between
    // passes (same as the comments card). Behavior above is the contract.
  });

  test("comments: a GIF rides along (stub picker)", async ({ page }) => {
    await ensureProfile(page);
    const title = `Gif chat ${test.info().testId}`;
    await page.goto("/quick");
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-when").fill("2026-10-11T18:00");
    await page.getByTestId("quick-create").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // Pick a gif (KLIPY_MODE=stub serves fixed results), post with no text.
    await page.getByTestId("comment-gif-open").click();
    // Trending loads on open; "Load more" pages via the cursor and appends.
    await expect(page.getByTestId("gif-grid")).toBeVisible();
    const before = await page.getByTestId("gif-grid").getByRole("button").count();
    await page.getByTestId("gif-more").click();
    await expect(async () => {
      expect(await page.getByTestId("gif-grid").getByRole("button").count()).toBeGreaterThan(before);
    }).toPass();
    await page.getByTestId("gif-q").fill("party");
    await page.getByTestId("gif-go").click();
    await page.getByTestId("gif-0").click();
    await expect(page.getByTestId("comment-gif-preview")).toBeVisible();
    await page.getByTestId("comment-post").click();
    await expect(page.getByTestId("comment").last().getByTestId("comment-gif")).toHaveAttribute("src", /gif-stub/);

    // Photos attach too: uploaded, client-downscaled, riding the same slot.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.getByTestId("comment-photo-file").setInputFiles({
      name: "pic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
    });
    await expect(page.getByTestId("comment-gif-preview")).toHaveAttribute("src", /^data:image\//);
    await page.getByTestId("comment-post").click();
    await expect(page.getByTestId("comment").last().getByTestId("comment-gif")).toHaveAttribute("src", /^data:image\//);
  });

  test("comments: post, delete, and the host can disable them", async ({ page }) => {
    await ensureProfile(page);
    const title = `Comments ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-01T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByTestId("comments")).toBeVisible();

    // Post a comment, then delete it (host moderates).
    await page.getByTestId("comment-input").fill("Looking forward to it!");
    await page.getByTestId("comment-post").click();
    await expect(page.getByText("Looking forward to it!")).toBeVisible();
    // Delete is two-tap like every destructive action (arm, then confirm).
    await page.getByTestId("comment-delete-0").click();
    await expect(page.getByTestId("comment-delete-0")).toHaveText("Delete?");
    await page.getByTestId("comment-delete-0").click();
    await expect(page.getByText("Looking forward to it!")).toHaveCount(0);

    // Host turns comments off → the composer disappears.
    await page.getByTestId("toggle-comments").click();
    await expect(page.getByTestId("comments-off")).toBeVisible();
    await expect(page.getByTestId("comment-input")).toHaveCount(0);
    // And back on.
    await page.getByTestId("toggle-comments").click();
    await expect(page.getByTestId("comment-input")).toBeVisible();
  });

  test("cohosts: host delegates, cohost can edit + moderate", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const coCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const co = await coCtx.newPage();
    try {
      await ensureUser(host, "chost", "C Host", "chost");
      await ensureUser(co, "cohostr", "Co Host", "cohostr");

      // Host creates an event and adds the cohost by handle.
      await host.getByTestId("new-event").click();
      const title = `Cohosted ${test.info().testId}`;
      await host.getByTestId("event-title").fill(title);
      await host.getByTestId("type-dinner").click();
      await host.getByTestId("wiz-next").click();
      await host.getByTestId("loc-host").click();
      await host.getByTestId("wiz-next").click();
      await host.getByTestId("sched-fixed").click();
      await host.getByTestId("fixed-time").fill("2026-08-02T19:00");
      await host.getByTestId("wiz-next").click();
      await host.getByTestId("create-event").click();
      await expect(host.getByTestId("event-title")).toHaveText(title);
      const url = host.url();

      await host.getByTestId("cohost-handle").fill("cohostr");
      await host.getByTestId("cohost-add").click();
      await expect(host.getByTestId("cohost")).toBeVisible();

      // A guest posts a comment the cohost will moderate.
      const guestCtx = await browser.newContext();
      const guest = await guestCtx.newPage();
      await ensureUser(guest, "cguest", "C Guest", "cguest");
      await guest.goto(url);
      await guest.getByTestId("comment-input").fill("Can I bring a friend?");
      await guest.getByTestId("comment-post").click();
      await expect(guest.getByText("Can I bring a friend?")).toBeVisible();

      // The gap fix: the cohost sees the event on their OWN dashboard under
      // Hosting - without ever having opened the invite link.
      await co.goto("/");
      await expect(co.getByTestId("event-row").filter({ hasText: title }).first()).toBeVisible();

      // The cohost opens the event: sees the manage view, can edit + moderate.
      await co.goto(url);
      await expect(co.getByTestId("share-link")).toBeVisible(); // manager view
      await expect(co.getByTestId("host-controls")).toHaveCount(0); // but not host-only controls
      await co.getByTestId("edit-event-open").click();
      await co.getByTestId("edit-title").fill(`${title} (edited)`);
      await co.getByTestId("edit-save").click();
      await expect(co.getByTestId("event-title")).toHaveText(`${title} (edited)`);
      // Cohost moderates the guest's comment (two-tap confirm).
      await co.getByTestId("comment-delete-0").click();
      await co.getByTestId("comment-delete-0").click();
      await expect(co.getByText("Can I bring a friend?")).toHaveCount(0);

      await guestCtx.close();
    } finally {
      await hostCtx.close();
      await coCtx.close();
    }
  });

  test("groups: create, add member, group event", async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const memberPage = await memberCtx.newPage();
    try {
      // Ensure the member user exists so the handle is available to add.
      await ensureUser(memberPage, "gmem", "G Mem", "gmem");

      // Set up owner and navigate to groups.
      await ensureUser(ownerPage, "gowner", "G Owner", "gowner");
      await ownerPage.goto("/?as=gowner");
      await ownerPage.goto("/groups");

      // Unique per run (testId is identical across the two e2e passes + the DB
      // persists), so the group name can't collide → no ambiguous .first().
      const testId = test.info().testId;
      const groupName = `Crew ${testId}-${Date.now()}`;
      await ownerPage.getByTestId("group-name").fill(groupName);
      await ownerPage.getByTestId("group-create").click();

      // Click the new group row by text.
      await ownerPage.getByText(groupName).first().click();

      // Group title is visible.
      await expect(ownerPage.getByTestId("group-title")).toBeVisible();

      // Add the member by handle.
      await ownerPage.getByTestId("member-handle").fill("gmem");
      await ownerPage.getByTestId("member-add").click();

      // Member shows up in the list.
      await expect(ownerPage.getByTestId("group-member").first()).toBeVisible();

      // Create a group event via the group-new-event button.
      await ownerPage.getByTestId("group-new-event").click();
      const eventTitle = `Group dinner ${testId}`;
      await ownerPage.getByTestId("event-title").fill(eventTitle);
      await ownerPage.getByTestId("type-dinner").click();
      await ownerPage.getByTestId("wiz-next").click();
      await ownerPage.getByTestId("loc-host").click();
      await ownerPage.getByTestId("wiz-next").click();
      await ownerPage.getByTestId("sched-fixed").click();
      await ownerPage.getByTestId("fixed-time").fill("2026-08-10T19:00");
      await ownerPage.getByTestId("wiz-next").click();
      await ownerPage.getByTestId("create-event").click();
      await expect(ownerPage.getByTestId("event-title")).toHaveText(eventTitle);

      // Go back to the group page and verify the event appears there.
      await ownerPage.goto("/groups");
      await ownerPage.getByText(groupName).first().click();
      await expect(ownerPage.getByTestId("group-event").filter({ hasText: eventTitle }).first()).toBeVisible();
    } finally {
      await ownerCtx.close();
      await memberCtx.close();
    }
  });

  test("recurring event: series occurrences created and navigable", async ({ page }) => {
    await ensureProfile(page);
    const title = `Weekly run ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-11T18:00");
    await page.getByTestId("repeat-weekly").click();
    await page.getByTestId("repeat-count").selectOption("3");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Series card: 3 occurrences, this is the first; siblings navigate.
    await expect(page.getByTestId("series")).toContainText("1 of 3");
    await page.getByTestId("series-occ-1").click();
    await expect(page.getByTestId("series")).toContainText("2 of 3");
    await expect(page.getByTestId("event-title")).toHaveText(title);
  });

  test("group icons: emoji-only and photo upload", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for an isolated owner");
    await ensureUser(page, "iconowner", "Icon Owner", "iconowner");
    await page.goto("/groups");
    // Emoji comes from the preset palette (free text is impossible in the UI
    // and rejected by the API).
    await page.getByTestId("group-emoji-🎲").click();
    const name = `Icons ${test.info().testId}`;
    await page.getByTestId("group-name").fill(name);
    await page.getByTestId("group-create").click();
    await page.getByText(name).first().click();
    await expect(page.getByTestId("group-title")).toHaveText(name);

    // Owner uploads a photo icon; it replaces the emoji (avatar img appears).
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.getByTestId("group-icon-file").setInputFiles({
      name: "icon.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
    });
    await expect(page.getByTestId("group-icon-pick")).toHaveText("Change photo");

    // A Klipy gif can be the icon too (stub picker).
    await page.getByTestId("group-icon-gif").click();
    await page.getByTestId("gif-q").fill("party");
    await page.getByTestId("gif-go").click();
    await page.getByTestId("gif-0").click();
    await expect(page.getByTestId("avatar-img").first()).toHaveAttribute("src", /gif-stub/);
  });

  test("discover: public event browsable, topic filter, follow → feed", async ({ page, browser, request }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    // The browse API is public - no auth headers at all.
    const unauth = await request.get("/api/discover");
    expect(unauth.status()).toBe(200);

    // Host publishes a public event with a topic.
    await ensureUser(page, "pubhost", "Pub Host", "pubhost");
    const title = `Stream ${test.info().testId}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-09-01T20:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // Creation no longer asks visibility (Discover is out of the nav) - the
    // host publishes from the event page's Edit form.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-vis-public").click();
    await page.getByTestId("edit-cat-streams").click();
    await page.getByTestId("edit-city").fill("Portland");
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-edit")).toHaveCount(0);

    // Another user finds it on Discover, filters by topic, follows the host.
    const fanCtx = await browser.newContext();
    try {
      const fan = await fanCtx.newPage();
      await ensureUser(fan, "fan1", "Fan One", "fan1");
      // Known starting state across the two-pass run: not following (the
      // follow button is a toggle, so a leftover follow would flip it OFF).
      await fan.evaluate(() =>
        fetch("/api/follows/host/pubhost", { method: "DELETE", headers: { "X-Dev-User": "fan1" } }),
      );
      await fan.goto("/discover");
      // .first(): the persistent two-pass DB can hold duplicates of this title,
      // and it can appear in both the feed and browse sections.
      await expect(fan.getByText(title).first()).toBeVisible();
      // Category chips are dynamic: only topics with an upcoming public event
      // render. No spec ever creates a 'wellness' event → no chip.
      await expect(fan.getByTestId("disc-cat-wellness")).toHaveCount(0);
      await fan.getByTestId("disc-cat-streams").click();
      await expect(fan.getByTestId("disc-event").filter({ hasText: title }).first()).toBeVisible();

      await fan.getByTestId("disc-event").filter({ hasText: title }).first()
        .getByTestId("follow-host").click();
      // Clear the filter (the For-you rail hides while filtering), then the
      // followed host's event ranks into the rail.
      await fan.getByTestId("disc-cat-streams").click();
      await expect(fan.getByTestId("feed-event").filter({ hasText: title }).first()).toBeVisible();
    } finally {
      await fanCtx.close();
    }
  });

  test("deletion: cancel event, delete group, decline + unfriend", async ({ page, browser }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "deleter", "Del Eter", "deleter");
    // Destructive buttons are two-tap confirms now (no native dialogs).

    // Cancel an event → page shows the cancelled state; it leaves the dashboard.
    const title = `Doomed ${test.info().testId}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-09-10T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await page.getByTestId("cancel-event").click(); // arm…
    await page.getByTestId("cancel-event").click(); // …confirm
    await expect(page.getByTestId("cancelled-note")).toBeVisible();
    await page.goto("/");
    await expect(page.getByText(title)).toHaveCount(0);

    // Delete a group → back on /groups without it.
    await page.goto("/groups");
    const gname = `Doomed crew ${test.info().testId}`;
    await page.getByTestId("group-name").fill(gname);
    await page.getByTestId("group-create").click();
    await page.getByText(gname).first().click();
    await page.getByTestId("group-delete").click(); // arm…
    await page.getByTestId("group-delete").click(); // …confirm
    await expect(page).toHaveURL(/\/groups$/);
    await expect(page.getByText(gname)).toHaveCount(0);

    // Friends: decline an incoming request, then unfriend an accepted one.
    const otherCtx = await browser.newContext();
    try {
      const other = await otherCtx.newPage();
      await ensureUser(other, "delfriend", "Del Friend", "delfriend");
      // delfriend requests deleter → deleter declines.
      await other.goto("/friends");
      await other.getByTestId("friend-handle").fill("deleter");
      await other.getByTestId("add-friend").click();
      await expect(other.getByText("Request sent ✓")).toBeVisible();
      await page.goto("/friends");
      await page.getByTestId("friend-handle").waitFor();
      await page.getByTestId("decline-delfriend").click();
      await expect(page.getByTestId("accept-delfriend")).toHaveCount(0);

      // Request again, accept this time, then unfriend.
      await other.goto("/friends");
      await other.getByTestId("friend-handle").waitFor();
      await other.getByTestId("friend-handle").fill("deleter");
      await other.getByTestId("add-friend").click();
      await page.goto("/friends");
      await page.getByTestId("friend-handle").waitFor();
      await page.getByTestId("accept-delfriend").click();
      await expect(page.getByTestId("unfriend-delfriend")).toBeVisible();
      await page.getByTestId("unfriend-delfriend").click(); // arm…
      await page.getByTestId("unfriend-delfriend").click(); // …confirm
      await expect(page.getByTestId("unfriend-delfriend")).toHaveCount(0);
    } finally {
      await otherCtx.close();
    }
  });

  test("friends-visible events show in the feed's Friends scope", async ({ page, browser, request }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    // fv1 hosts a friends-visible event (not on public Discover). Date.now()
    // keeps the title unique across the two e2e passes (persistent DB): pass 2
    // must not target pass 1's copy, whose RSVP state has diverged.
    await ensureUser(page, "fv1", "F V One", "fv1");
    const title = `Friends only ${test.info().testId}-${Date.now()}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-09-05T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // Visibility moved off the wizard - set it from the edit form.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-vis-friends").click();
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-edit")).toHaveCount(0);

    const otherCtx = await browser.newContext();
    try {
      const fv2 = await otherCtx.newPage();
      await ensureUser(fv2, "fv2", "F V Two", "fv2");
      // Befriend (idempotent across passes: accept only if pending).
      await fv2.goto("/friends");
      await fv2.getByTestId("friend-handle").fill("fv1");
      await fv2.getByTestId("add-friend").click();
      await page.goto("/friends");
      await page.getByTestId("friend-handle").waitFor();
      const accept = page.getByTestId("accept-fv2");
      if (await accept.isVisible().catch(() => false)) await accept.click();
      await expect(page.getByTestId("unfriend-fv2")).toBeVisible();

      // fv2's Friends scope shows it; the public browse list does not.
      await fv2.goto("/discover");
      await fv2.getByTestId("scope-friends").click();
      const row = fv2.getByTestId("feed-event").filter({ hasText: title }).first();
      // Ranked-feed fetch + render across two contexts - allow extra time under
      // CI load (the default 5s flakes when the runner is starved).
      await expect(row).toBeVisible({ timeout: 15000 });
      // Each event renders exactly once: it's in the For-you rail, so the
      // browse list below must NOT duplicate it - and it never leaks to the
      // anonymous public endpoint.
      await expect(fv2.getByTestId("disc-event").filter({ hasText: title })).toHaveCount(0);
      const pub = await request.get("/api/discover");
      expect(await pub.text()).not.toContain(title);

      // Tier styling: a friend's event glows green until you're going (in the
      // second e2e pass the RSVP from pass 1 persists → already tile-going).
      if (!((await row.getAttribute("class")) ?? "").includes("tile-going")) {
        await expect(row).toHaveClass(/tile-friend/);
      }
      await fv2.getByText(title).first().click(); // open → RSVP going
      const fv2Rsvp = fv2.waitForResponse((r) => r.url().includes("/rsvp") && r.ok());
      await fv2.getByTestId("rsvp-going").click();
      await fv2Rsvp; // optimistic UI: wait for the background POST before navigating
      await fv2.goto("/discover");
      await fv2.getByTestId("scope-friends").click();
      await expect(fv2.getByTestId("feed-event").filter({ hasText: title }).first()).toHaveClass(/tile-going/);

      // Social proof: the host (fv2's friend) also RSVPs going → fv2's tile
      // shows "1 friend going". (Hosts don't appear in their own feed.)
      await page.goto("/");
      await page.getByText(title).first().click();
      await page.getByTestId("preview-toggle").click();
      const hostRsvp = page.waitForResponse((r) => r.url().includes("/rsvp") && r.ok());
      await page.getByTestId("rsvp-going").click();
      await hostRsvp; // ensure it landed before the other browser re-checks
      await fv2.reload();
      await fv2.getByTestId("scope-friends").click();
      await expect(
        fv2.getByTestId("feed-event").filter({ hasText: title }).first().getByTestId("friends-going"),
      ).toHaveText(/1 friend going/, { timeout: 15000 });
    } finally {
      await otherCtx.close();
    }
  });

  test("edit can take a private event public", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for an isolated user");
    await ensureUser(page, "editpub", "Edit Pub", "editpub");
    const title = `Went public ${test.info().testId}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-movie").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-09-12T20:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click(); // private by default
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Edit → Public + a category → it appears on Discover.
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-vis-public").click();
    await page.getByTestId("edit-cat-gaming").click();
    await page.getByTestId("edit-save").click();
    await page.goto("/discover");
    await expect(page.getByText(title).first()).toBeVisible(); // rail or browse
  });

  test("public polls are discoverable before a time is set", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for an isolated user");
    await ensureUser(page, "pollpub", "Poll Pub", "pollpub");
    const title = `Open poll ${test.info().testId}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-general").click(); // polling: no time yet
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // Publish via the edit form (visibility moved off the wizard).
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-vis-public").click();
    await page.getByTestId("edit-cat-social").click();
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-edit")).toHaveCount(0);

    // The Discover filter starts EMPTY (no timezone prefill hiding results)
    // and time-less polls are listed.
    await page.goto("/discover");
    await expect(page.getByTestId("disc-city")).toHaveValue("");
    await expect(page.getByText(title).first()).toBeVisible(); // rail or browse, exactly once
  });

  test("region filter matches member cities", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for an isolated user");
    await ensureUser(page, "regionist", "Region Ist", "regionist");
    const title = `Oakland meetup ${test.info().testId}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-09-15T18:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // Publish via the edit form (visibility moved off the wizard).
    await page.getByTestId("edit-event-open").click();
    await page.getByTestId("edit-vis-public").click();
    await page.getByTestId("edit-cat-tech").click();
    await page.getByTestId("edit-city").fill("Oakland");
    await page.getByTestId("edit-save").click();
    await expect(page.getByTestId("hero-edit")).toHaveCount(0);

    // Filtering by the metro region finds the member-city event.
    await page.goto("/discover");
    await page.getByTestId("disc-city").fill("Bay Area, CA");
    await expect(page.getByTestId("disc-event").filter({ hasText: title }).first()).toBeVisible();
    // A different region does not.
    await page.getByTestId("disc-city").fill("Tampa Bay, FL");
    await expect(page.getByTestId("disc-event").filter({ hasText: title })).toHaveCount(0);
  });

  test("invites: badge counts, invite a friend, invitee sees the event", async ({ page, browser }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    const bCtx = await browser.newContext();
    try {
      const b = await bCtx.newPage();
      await ensureUser(b, "invB", "Inv Bee", "invb");
      await ensureUser(page, "invA", "Inv Ay", "inva");

      // A requests B → B's Friends nav shows a red count.
      await page.goto("/friends");
      await page.getByTestId("friend-handle").waitFor();
      const already = await page.getByTestId("unfriend-invb").isVisible().catch(() => false);
      if (!already) {
        await page.getByTestId("friend-handle").fill("invb");
        await page.getByTestId("add-friend").click();
        await b.goto("/friends");
        await expect(b.getByTestId("nav-badge-friends")).toHaveText("1");
        await b.getByTestId("accept-inva").click();
      }
      await b.goto("/friends");
      await expect(b.getByTestId("unfriend-inva")).toBeVisible();

      // A hosts an event and invites friend B from the event page.
      const title = `Invited ${test.info().testId}`;
      await page.goto("/new");
      await page.getByTestId("event-title").fill(title);
      await page.getByTestId("type-dinner").click();
      await page.getByTestId("wiz-next").click();
      await page.getByTestId("loc-host").click();
      await page.getByTestId("wiz-next").click();
      await page.getByTestId("sched-fixed").click();
      await page.getByTestId("fixed-time").fill("2026-09-20T19:00");
      await page.getByTestId("wiz-next").click();
      await page.getByTestId("winvite-invb").click(); // invite from the wizard's Who step
      await page.getByTestId("create-event").click();
      await expect(page.getByTestId("event-title")).toHaveText(title);
      await expect(page.getByText("Invited: Inv Bee")).toBeVisible();

      // B: red count on Events + the event on the dashboard (no link needed),
      // marked NEW. The alert PERSISTS across dashboard views - it only clears
      // when B actually opens that event.
      await b.goto("/friends");
      await expect(b.getByTestId("nav-badge-events")).toBeVisible();
      const bTile = b.getByTestId("event-row").filter({ hasText: title }).first();
      await b.goto("/");
      await expect(bTile).toBeVisible();
      await expect(bTile.getByTestId("event-new")).toBeVisible();
      // Viewing the dashboard again does NOT clear it.
      await b.goto("/friends");
      await b.goto("/");
      await expect(bTile).toBeVisible();
      await expect(b.getByTestId("nav-badge-events")).toBeVisible();
      // Open the event → marker + badge clear.
      await bTile.click();
      await expect(b.getByTestId("event-title")).toHaveText(title);
      await b.goto("/");
      await expect(b.getByTestId("event-row").filter({ hasText: title }).first()
        .getByTestId("event-new")).toHaveCount(0);
      await expect(b.getByTestId("nav-badge-events")).toHaveCount(0);
    } finally {
      await bCtx.close();
    }
  });

  test("custom event types: + chip, emoji + short name, saved for reuse", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for an isolated user");
    await ensureUser(page, "typer", "Ty Per", "typer");
    const title = `Strike night ${test.info().testId}`;
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-add").click();
    await page.getByTestId("newtype-emoji-🎳").click();
    await page.getByTestId("newtype-name").fill("Bowling");
    await page.getByTestId("newtype-save").click();
    // The new type appears as a SELECTED chip, styled like the preset types.
    await expect(page.getByTestId("custom-bowling")).toHaveClass(/on/);
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-09-25T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();

    // The event displays the custom emoji + name instead of a preset type.
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByText("Bowling").first()).toBeVisible();

    // The type is saved and reappears as a chip for next time.
    await page.goto("/new");
    await expect(page.getByTestId("custom-bowling")).toBeVisible();
  });

  test("zero-signup: start a plan from scratch, share-ready", async ({ browser }) => {
    test.skip(!DEV_AUTH, "guest flow uses the dev ?guest=1 hook");
    const ctx = await browser.newContext();
    try {
      const p = await ctx.newPage();
      await p.goto("/start?guest=1");
      await p.getByTestId("guest-name").fill("Zero Sign");
      await p.getByTestId("guest-join").click();
      // Lands on Quick plan: title + time → event page with the invite link.
      await p.getByTestId("quick-title").fill(`Zero ${test.info().testId}`);
      await p.getByTestId("quick-when").fill("2026-10-01T19:00");
      await p.getByTestId("quick-create").click();
      await expect(p.getByTestId("share-link")).toBeVisible();
      await expect(p.getByTestId("guest-banner")).toBeVisible(); // convert nudge
    } finally {
      await ctx.close();
    }
  });

  test("quick plan: title + time → shareable event", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/");
    await page.getByTestId("quick-plan").click();
    const title = `Fast ${test.info().testId}`;
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-when").fill("2026-10-02T18:00");
    await page.getByTestId("quick-create").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByTestId("share-link")).toBeVisible();
  });

  test("quick plan: availability mode asks when people are free", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/quick");
    const title = `Fast avail ${test.info().testId}`;
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-mode-avail").click();
    // Quick defaults to asking about THIS WEEK (scope chips let the host widen it).
    await expect(page.getByTestId("quick-scope-week")).toHaveClass(/on/);
    await page.getByTestId("quick-create").click();
    // Lands as a scoped general poll; guests get a concrete-dates week grid.
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByText("Time being decided")).toBeVisible();
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByText("When are you free this week?")).toBeVisible();
    await expect(page.getByTestId("gpw-cell-0-evening")).toBeVisible();
  });

  test("general poll scopes: this week and this month shape the ask", async ({ page }) => {
    await ensureProfile(page);

    // Week scope via Quick: attendee answers a concrete-dates grid; the host
    // aggregate is a date×daypart heatmap over the same 7-day window.
    await page.goto("/quick");
    await page.getByTestId("quick-title").fill(`Week scope ${test.info().testId}`);
    await page.getByTestId("quick-mode-avail").click();
    await page.getByTestId("quick-scope-week").click();
    await page.getByTestId("quick-create").click();
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await page.getByTestId("gpw-cell-1-evening").click();
    await page.getByTestId("gpw-cell-2-noon").click();
    await page.getByTestId("save-general").click();
    await expect(page.getByTestId("save-general")).toHaveText("Saved ✓");
    // Saved picks survive a reload (persisted, not just local state).
    await page.reload();
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByTestId("gpw-cell-1-evening")).toHaveClass(/on/);
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByTestId("gr-week-heat")).toBeVisible();
    await expect(page.getByTestId("gr-week-heat")).toContainText("1");

    // Month scope via the wizard: attendee taps day chips; host sees ranked days.
    await page.goto("/");
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(`Month scope ${test.info().testId}`);
    await page.getByTestId("type-other").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-general").click();
    await page.getByTestId("scope-month").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await expect(page.getByText("Which days work this month?")).toBeVisible();
    // Month is a dates × dayparts grid now (28 days) - pick times, not just days.
    await page.getByTestId("gpm-cell-5-evening").click();
    await page.getByTestId("gpm-cell-12-noon").click();
    await page.getByTestId("save-general").click();
    await expect(page.getByTestId("save-general")).toHaveText("Saved ✓");
    await page.getByTestId("preview-toggle").click();
    // Host sees the heatmap and schedules straight from a cell: tap the winning
    // cell → it lands in the picks → schedule.
    await expect(page.getByTestId("gr-month-heat")).toBeVisible();
    const cellDate = (days: number) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    await page.getByTestId(`grm-pick-${cellDate(5)}-evening`).click();
    await expect(page.getByTestId("picked-cells")).toBeVisible();
    await page.getByTestId("general-finalize").click();
    await expect(page.getByTestId("event-title")).toBeVisible();
    await expect(page.getByText("Confirmed")).toBeVisible();
  });

  test("general poll finalizes MULTIPLE winning dates into a series", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    await ensureUser(page, "mfin1", "Multi Fin", "mfin1");
    const title = `MultiFin ${test.info().testId}-${Date.now()}`;
    const dt = (days: number) => {
      const d = new Date(Date.now() + days * 24 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
    };
    await page.goto("/new");
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-general").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    // RSVP as a participant so someone is carried onto the extra dates.
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await page.getByTestId("preview-toggle").click();

    // The manually-typed time can be CLEARED again (the old bug: with a cell
    // pick present, the typed date had no way out).
    await page.getByTestId("general-finalize-time").fill(dt(4));
    await page.getByTestId("general-finalize-clear").click();
    await expect(page.getByTestId("general-finalize-time")).toHaveValue("");

    // Host can target a specific MONTH: pick next month, tap a weekday cell -
    // the resolved date lands in that month (shown as a removable chip).
    const nm = new Date(); nm.setMonth(nm.getMonth() + 1, 1);
    const nmValue = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, "0")}`;
    const nmShort = nm.toLocaleDateString("en-US", { month: "short" });
    await page.getByTestId(`target-month-${nmValue}`).click();
    await page.getByTestId("grg-pick-1-evening").click();
    await expect(page.getByTestId("picked-cells")).toContainText(nmShort);
    // unpick - back to manual-only for the rest of this test
    await page.getByTestId(`picked-${nmValue}|1:evening`).click();
    await expect(page.getByTestId("picked-cells")).toHaveCount(0);

    // Host picks TWO winning dates from the group's availability.
    await page.getByTestId("general-finalize-time").fill(dt(3));
    await page.getByTestId("general-add-date").click();
    await page.getByTestId("general-finalize-time-1").fill(dt(9));
    await page.getByTestId("general-finalize").click();

    // One series, both dates; the RSVP carried onto the sibling occurrence.
    await expect(page.getByTestId("series")).toContainText("1 of 2");
    await page.getByTestId("series-occ-1").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByTestId("series")).toContainText("2 of 2");
    await expect(page.getByText("1 going · 1 responded")).toBeVisible();
  });

  test("invite links unfurl: /e/{id} serves Open Graph tags", async ({ page, request }) => {
    await ensureProfile(page);
    const title = `Unfurl ${test.info().testId}`;
    await page.goto("/quick");
    await page.getByTestId("quick-title").fill(title);
    await page.getByTestId("quick-when").fill("2026-10-03T18:00");
    await page.getByTestId("quick-create").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const id = page.url().split("/e/")[1];

    // A no-JS fetch (what iMessage/WhatsApp bots do) gets real OG tags…
    const res = await request.get(`/e/${id}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain(`og:title`);
    expect(html).toContain(title);
    expect(html).toContain("no account needed");
    // …and a real browser full-load gets bounced into the SPA.
    await page.goto(`/e/${id}`);
    await expect(page).toHaveURL(new RegExp(`/ev/${id}`));
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Social proof rides the unfurl from two going up ("N in so far").
    // The viewer hosts this event (no RSVP buttons), so two dev users RSVP
    // via the API instead.
    if (DEV_AUTH) {
      await page.evaluate(async (eid) => {
        for (const u of ["unfurl2", "unfurl3"]) {
          const h = { "Content-Type": "application/json", "X-Dev-User": u };
          await fetch("/api/profile", { method: "PUT", headers: h, body: JSON.stringify({ display_name: `Unfurl ${u}`, handle: u }) });
          await fetch(`/api/events/${eid}/rsvp`, { method: "POST", headers: h, body: JSON.stringify({ rsvp: "going" }) });
        }
      }, id);
      const social = await request.get(`/e/${id}`);
      expect(await social.text()).toMatch(/[0-9] in so far/);
    }
  });

  test("people you may know: suggested from a shared event", async ({ browser }) => {
    test.skip(!DEV_AUTH, "uses ?as for isolated users");
    const hCtx = await browser.newContext();
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    try {
      const host = await hCtx.newPage(); const a = await aCtx.newPage(); const b = await bCtx.newPage();
      await ensureUser(host, "rechost", "Rec Host", "rechost");
      await ensureUser(a, "reca", "Rec Ay", "reca");
      await ensureUser(b, "recb", "Rec Bee", "recb");

      // Host runs an event; A and B both RSVP going (co-attendance).
      await host.getByTestId("new-event").click();
      const title = `Shared ${test.info().testId}`;
      await host.getByTestId("event-title").fill(title);
      await host.getByTestId("type-dinner").click();
      await host.getByTestId("wiz-next").click();
      await host.getByTestId("wiz-next").click();
      await host.getByTestId("sched-fixed").click();
      await host.getByTestId("fixed-time").fill("2026-10-10T19:00");
      await host.getByTestId("wiz-next").click();
      await host.getByTestId("create-event").click();
      await expect(host.getByTestId("event-title")).toHaveText(title);
      const url = host.url();

      for (const p of [a, b]) {
        await p.goto(url);
        await p.getByTestId("rsvp-going").click();
        await expect(p.getByTestId("event-title")).toHaveText(title);
      }

      // A now sees B under "People you may know", and can add them. Clear any
      // leftover pending request from a previous pass first (persistent DB).
      await a.goto("/friends");
      await a.getByTestId("friend-handle").waitFor();
      const leftover = a.getByTestId("cancel-req-recb");
      if (await leftover.isVisible().catch(() => false)) await leftover.click();
      await expect(a.getByTestId("suggest-add-recb")).toBeVisible();
      await a.getByTestId("suggest-add-recb").click();
      // A pending request now exists → B drops out of suggestions.
      await expect(a.getByTestId("suggest-add-recb")).toHaveCount(0);
    } finally {
      await hCtx.close(); await aCtx.close(); await bCtx.close();
    }
  });

  test("home filters: hosting vs attending", async ({ page }) => {
    await ensureProfile(page);
    const title = `Filtered ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-11-01T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    await page.goto("/");
    // Hosting filter shows it; Attending filter (host isn't attending) hides it.
    await page.getByTestId("filter-hosting").click();
    await expect(page.getByTestId("event-row").filter({ hasText: title }).first()).toBeVisible();
    await page.getByTestId("filter-attending").click();
    await expect(page.getByTestId("event-row").filter({ hasText: title })).toHaveCount(0);
    await page.getByTestId("filter-all").click();
    await expect(page.getByTestId("event-row").filter({ hasText: title }).first()).toBeVisible();
  });

  test("theme: dark by default, switch to light persists", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/profile");
    const htmlEl = page.locator("html");
    await expect(htmlEl).not.toHaveAttribute("data-theme", "light"); // dark default
    await page.getByTestId("theme-light").click();
    await expect(htmlEl).toHaveAttribute("data-theme", "light");
    await page.reload(); // no-flash script re-applies from localStorage
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "light");
  });

  test("cron reminders endpoint is key-gated", async ({ request }) => {
    const noKey = await request.post("/api/cron/reminders");
    expect(noKey.status()).toBe(401); // no CRON_KEY configured/matched
  });

  test("intent links on scheduled events", async ({ page }) => {
    await ensureProfile(page);

    const testId = test.info().testId;
    const title = `Intent ${testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-01T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // The intent link for dinner should be visible and point to opentable.
    const link = page.getByTestId("intent-dinner");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain("opentable.com");
  });

  test("guest → account merge: plans follow you when you sign up", async ({ browser }) => {
    test.skip(!DEV_AUTH, "guest flow via the dev ?guest=1 hook");
    const target = `merged${test.info().testId}${Date.now()}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
    const ctx = await browser.newContext();
    try {
      const g = await ctx.newPage();
      // Start as a no-account guest; ?as targets a fresh dev user for the merge.
      await g.goto(`/start?guest=1&as=${target}`);
      await g.getByTestId("guest-name").fill("Merge Me");
      await g.getByTestId("guest-join").click();
      await expect(g.getByTestId("guest-banner")).toBeVisible();

      // The guest hosts an event (from Home - /start is the Quick page).
      await g.goto("/");
      const title = `Merge plan ${test.info().testId}-${Date.now()}`;
      await g.getByTestId("new-event").click();
      await g.getByTestId("event-title").fill(title);
      await g.getByTestId("type-dinner").click();
      await g.getByTestId("wiz-next").click();
      await g.getByTestId("loc-host").click();
      await g.getByTestId("wiz-next").click();
      await g.getByTestId("sched-fixed").click();
      await g.getByTestId("fixed-time").fill("2026-08-20T19:00");
      await g.getByTestId("wiz-next").click();
      await g.getByTestId("create-event").click();
      await expect(g.getByTestId("event-title")).toHaveText(title);

      // Sign up → the guest identity merges into the new account.
      await g.goto("/");
      await g.getByTestId("guest-signup").click();
      // Hard reload → authed as `target` → the guest's content merges in. The
      // account then lands on either first-run setup (fresh) or the dashboard;
      // complete setup if shown. The guarantee under test is that the plan
      // followed them, whichever screen appears.
      await Promise.race([
        g.getByTestId("setup-name").waitFor({ timeout: 20000 }),
        g.getByTestId("event-row").first().waitFor({ timeout: 20000 }),
      ]).catch(() => {});
      if (await g.getByTestId("setup-name").isVisible().catch(() => false)) {
        await g.getByTestId("setup-name").fill("Merge Me");
        await g.getByTestId("setup-handle").fill(target);
        await g.getByTestId("setup-save").click();
      }
      await expect(g.getByTestId("event-row").filter({ hasText: title })).toBeVisible({ timeout: 20000 });
    } finally {
      await ctx.close();
    }
  });

  test("guest joins from an invite link with just a name", async ({ page, browser }) => {
    test.skip(!DEV_AUTH, "guest flow is exercised via the dev ?guest=1 hook");
    await ensureProfile(page);

    // Host creates a fixed event to invite someone to.
    const title = `Guesty ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-09T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);
    const url = page.url();

    // A signed-out visitor opens the invite: name → join → RSVP → comment.
    const guestCtx = await browser.newContext();
    try {
      const guest = await guestCtx.newPage();
      await guest.goto(`${url}?guest=1`);
      await guest.getByTestId("guest-name").fill("Guest Gal");
      await guest.getByTestId("guest-join").click();
      await expect(guest.getByTestId("event-title")).toHaveText(title);
      // The conversion nudge shows for guest identities.
      await expect(guest.getByTestId("guest-banner")).toBeVisible();
      await expect(guest.getByTestId("guest-signup")).toBeVisible(); // conversion CTA
      await guest.getByTestId("rsvp-going").click();
      await guest.getByTestId("comment-input").fill("So excited!");
      await guest.getByTestId("comment-post").click();
      await expect(guest.getByText("So excited!")).toBeVisible();
    } finally {
      await guestCtx.close();
    }

    // The host sees the guest's participation (name may appear in both the
    // guest list and the comment byline - assert at least one).
    await page.reload();
    await expect(page.getByText("Guest Gal").first()).toBeVisible();
  });

  test("imported busy times flag conflicting poll options", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses the stubbed calendar (CALENDAR_MODE=stub)");
    // A dedicated user connects the stub Google calendar (Dentist: Aug 3, 9-11am).
    await ensureUser(page, "busyvoter", "Busy Voter", "busyvoter");
    await page.goto("/profile");
    await expect(page.getByTestId("calendar-connections")).toBeVisible();
    if (await page.getByTestId("connect-google").isVisible().catch(() => false)) {
      await page.getByTestId("connect-google").click();
      await expect(page.getByTestId("disconnect-google")).toBeVisible();
    }

    // A poll with one option inside the busy window and one outside.
    await page.goto("/new");
    await page.getByTestId("event-title").fill(`Busy ${test.info().testId}`);
    await page.getByTestId("type-movie").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-poll").click();
    await page.getByTestId("poll-option-0").fill("2026-08-03T09:30");
    await page.getByTestId("add-option").click();
    await page.getByTestId("poll-option-1").fill("2026-08-20T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();

    // Voting view (host previews as guest) shows the conflict badge on option 0 only.
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByTestId("busy-0")).toBeVisible();
    await expect(page.getByTestId("busy-1")).toHaveCount(0);
  });

  test("specific-times poll: vote and finalize", async ({ page }) => {
    await ensureProfile(page);

    const title = `Movie ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-movie").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-poll").click();
    await page.getByTestId("poll-option-0").fill("2026-08-01T19:00");
    await page.getByTestId("add-option").click();
    await page.getByTestId("poll-option-1").fill("2026-08-02T19:00");
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // Vote as a guest on both options.
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await page.getByTestId("vote-0-yes").click();
    await page.getByTestId("vote-1-yes").click();
    await page.getByTestId("save-votes").click();

    // Host picks the first option → event becomes confirmed.
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("finalize-0").click();
    await expect(page.getByText("Confirmed")).toBeVisible();
  });

  test("edit profile and date-based availability", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/profile");
    await page.getByTestId("profile-edit").click(); // tile is read-only until Edit
    await page.getByTestId("profile-name").fill("Demo Host");
    await page.getByTestId("save-profile").click();
    await expect(page.getByTestId("profile-view")).toBeVisible(); // back to read-only
    // Explicit calendar: tomorrow evening, day-after noon.
    await page.getByTestId("avail-edit").click();
    await page.getByTestId("avail-cell-1-evening").click();
    await page.getByTestId("avail-cell-2-noon").click();
    await page.getByTestId("save-availability").click();
    await expect(page.getByText("Availability saved ✓")).toBeVisible();
  });

  test("availability: recurring weekly and paginated specific dates", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/profile");

    // Recurring weekly mode: enter edit, pick Monday morning + Friday evening, save.
    await page.getByTestId("avail-edit").click();
    await page.getByTestId("avail-mode-weekly").click();
    await expect(page.getByTestId("weekly-grid")).toBeVisible();
    await page.getByTestId("wk-cell-1-morning").click();
    await page.getByTestId("wk-cell-5-evening").click();
    await page.getByTestId("save-weekly").click();
    await expect(page.getByText("Availability saved ✓")).toBeVisible();

    // Specific dates: re-enter edit, paginate into the future, mark a cell.
    await page.getByTestId("avail-edit").click();
    await page.getByTestId("avail-mode-specific").click();
    await expect(page.getByTestId("avail-earlier")).toBeDisabled(); // present is the floor
    const firstRange = await page.getByTestId("avail-range").textContent();
    await page.getByTestId("avail-later").click();
    await expect(page.getByTestId("avail-earlier")).toBeEnabled();
    await expect(page.getByTestId("avail-range")).not.toHaveText(firstRange ?? "");
    await page.getByTestId("avail-cell-0-evening").click(); // a date ~2 weeks out
    await page.getByTestId("save-availability").click();
    await expect(page.getByText("Availability saved ✓")).toBeVisible();
  });

  test("availability: legend + tri-state free/busy painting", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/profile");
    await page.getByTestId("avail-edit").click();
    // A color key explains the three states.
    await expect(page.getByTestId("avail-legend")).toContainText("Free");
    await expect(page.getByTestId("avail-legend")).toContainText("Busy");
    await expect(page.getByTestId("avail-legend")).toContainText("Not set");
    const cell = page.getByTestId("avail-cell-0-morning");
    // Default brush is "free": a cell tap turns it green (.on).
    await expect(page.getByTestId("paint-free")).toHaveClass(/on/);
    await cell.click();
    await expect(cell).toHaveClass(/on/);
    // Switch to the "busy" brush: tapping the same cell repaints it red, never green.
    await page.getByTestId("paint-busy").click();
    await cell.click();
    await expect(cell).toHaveClass(/busy-mark/);
    await expect(cell).not.toHaveClass(/\bon\b/);
    // Tapping a busy cell again clears it back to unselected (neither class).
    await cell.click();
    await expect(cell).not.toHaveClass(/busy-mark/);
    await expect(cell).not.toHaveClass(/\bon\b/);
    // Busy marks persist through a save + reload (the real bug being fixed).
    await cell.click(); // busy again
    await page.getByTestId("save-availability").click();
    await expect(page.getByText("Availability saved ✓")).toBeVisible();
    await page.reload();
    await page.getByTestId("avail-edit").click();
    await expect(page.getByTestId("avail-cell-0-morning")).toHaveClass(/busy-mark/);
  });

  test("availability weekly grid visual baseline", async ({ page }) => {
    test.skip(!DEV_AUTH, "uses ?as for a clean, unsaved availability state");
    // A fresh user with no saved availability → deterministic empty grid.
    await ensureUser(page, "availviz", "Avail Viz", "availviz");
    await page.goto("/profile");
    await page.getByTestId("avail-edit").click();
    await page.getByTestId("avail-mode-weekly").click();
    await expect(page.getByTestId("weekly-grid")).toBeVisible();
    await expect(page.getByTestId("weekly-grid")).toHaveScreenshot("weekly-grid.png");
  });

  test("mobile: bottom tab bar navigates and highlights", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // phone-sized
    await ensureProfile(page);

    const bar = page.getByTestId("tabbar");
    await expect(bar).toBeVisible(); // shows only at mobile widths

    // Each tab navigates to its page.
    await page.getByTestId("tab-friends").click();
    await expect(page).toHaveURL(/\/friends$/);
    await page.getByTestId("tab-calendars").click();
    await expect(page).toHaveURL(/\/calendars$/);
    await page.getByTestId("tab-profile").click();
    await expect(page).toHaveURL(/\/profile$/);
    await page.getByTestId("tab-events").click();
    await expect(page).toHaveURL(/\/$/);

    // Active tab is highlighted; visual baseline of the (fixed-height) bar.
    await expect(page.getByTestId("tab-events")).toHaveClass(/active/);
    await expect(bar).toHaveScreenshot("tabbar.png");
  });

  test("upload a profile photo", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/profile");
    await page.getByTestId("profile-edit").click(); // photo picker lives in edit mode
    // 1x1 PNG; the client resizes it to a JPEG data URL before saving.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.getByTestId("avatar-file").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    // The circle-crop dialog opens first: avatars display as circles, so the
    // user picks which circle of their photo to keep.
    await expect(page.getByTestId("crop-modal")).toBeVisible();
    await expect(page.locator(".crop-circle")).toBeVisible();
    await page.getByTestId("crop-save").click();
    await expect(page.getByText("Photo updated ✓")).toBeVisible();
    await expect(page.getByTestId("avatar-img").first()).toHaveAttribute("src", /^data:image\//);
  });

  test("friends: request, accept, and view availability", async ({ browser }) => {
    const amyCtx = await browser.newContext();
    const benCtx = await browser.newContext();
    const amy = await amyCtx.newPage();
    const ben = await benCtx.newPage();
    try {
      await ensureUser(ben, "ben", "Ben", "ben");
      // Ben marks some availability so Amy has something to see.
      await ben.goto("/profile");
      await ben.getByTestId("avail-edit").click();
      await ben.getByTestId("avail-cell-2-afternoon").click();
      await ben.getByTestId("save-availability").click();
      await expect(ben.getByText("Availability saved ✓")).toBeVisible();

      await ensureUser(amy, "amy", "Amy", "amy");
      await amy.goto("/friends");
      await amy.getByTestId("friend-handle").fill("ben");
      await amy.getByTestId("add-friend").click();
      await expect(amy.getByText("Request sent ✓")).toBeVisible(); // request persisted

      // Ben accepts (only if a request is pending - keeps the run idempotent),
      // then wait until Amy shows as an accepted friend so the round-trip is done.
      await ben.goto("/friends");
      // Wait for the page to finish its initial load first - a non-waiting
      // isVisible() during the loading spinner would skip the accept step.
      await ben.getByTestId("friend-handle").waitFor();
      const accept = ben.getByTestId("accept-amy");
      if (await accept.isVisible().catch(() => false)) await accept.click();
      await expect(ben.getByTestId("view-avail-amy")).toBeVisible();

      // Amy now sees Ben as an accepted friend and can open his availability.
      await amy.goto("/friends");
      await amy.getByTestId("view-avail-ben").click();
      await expect(amy.getByTestId("friend-availability")).toBeVisible();
    } finally {
      await amyCtx.close();
      await benCtx.close();
    }
  });
});

// Set up a dev user in its own tab/context: ?as=<id> selects the API user; then
// ensure a profile with the given name/handle exists (idempotent across reruns).
async function ensureUser(
  page: import("@playwright/test").Page,
  devUser: string,
  name: string,
  handle: string,
) {
  await page.goto(`/?as=${devUser}`);
  await page.waitForSelector('[data-testid="setup-name"], [data-testid="new-event"]');
  if (await page.getByTestId("setup-name").isVisible()) {
    await page.getByTestId("setup-name").fill(name);
    await page.getByTestId("setup-handle").fill(handle);
    await page.getByTestId("setup-save").click();
  }
  await expect(page.getByTestId("new-event")).toBeVisible();
}
