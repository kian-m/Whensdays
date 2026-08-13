import { test, expect } from "@playwright/test";

// Generates the README/gallery feature screenshots from the live app. Runs ONLY
// in docs mode (DOCS_SHOTS=1, set by `make docs-shots`); skipped during normal
// E2E. Add a capture here for every new feature/page so the docs stay current.
const OUT = process.env.DOCS_OUT || "/out";

// Dates here must be RELATIVE to today. A hardcoded calendar date rots the
// moment it passes: past events drop out of every active view (eventIsPast), so
// the seeded events would silently vanish from the dashboard screenshot.
// Built from LOCAL components - toISOString() would give the UTC date, which can
// be a day off from what a datetime-local input means.
function future(daysAhead: number, hhmm: string) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${hhmm}`;
}

test.describe("docs screenshots", () => {
  test.skip(!process.env.DOCS_SHOTS, "docs screenshot mode only");
  test.use({ viewport: { width: 960, height: 760 } });

  test("capture scheduler pages", async ({ page }) => {
    // First run on a fresh DB: set up the minimal profile.
    await page.goto("/");
    await page.waitForSelector('[data-testid="setup-name"], [data-testid="new-event"]');
    if (await page.getByTestId("setup-name").isVisible()) {
      await page.getByTestId("setup-name").fill("Alex Rivera");
      await page.getByTestId("setup-handle").fill("alex");
      await page.getByTestId("setup-save").click();
    }
    await expect(page.getByTestId("new-event")).toBeVisible();

    // Seed a few distinct events so the dashboard looks alive.
    // Spacing preserved from the original fixed dates (dinner, +2d matinee,
    // +7d drinks) so the dashboard keeps the same near/mid/far spread.
    await createFixed(page, "Sunday matinee", future(23, "14:00"));
    await createFixed(page, "Rooftop drinks", future(28, "18:30"));
    await createFixed(page, "Friday dinner", future(21, "19:30"));
    await createAvailPoll(page, "Camping weekend");

    // Feature: home dashboard (this is the gallery home-page screenshot).
    await page.goto("/");
    await page.getByTestId("event-row").first().waitFor();
    await page.screenshot({ path: `${OUT}/01-scheduler-home.png`, fullPage: true, animations: "disabled" });

    // Feature: event page (host view) with the invite link + management.
    await page.getByTestId("event-row").first().click();
    await page.getByTestId("share-link").waitFor();
    await page.screenshot({ path: `${OUT}/02-scheduler-event.png`, fullPage: true, animations: "disabled" });

    // Feature: general-availability poll - the per-day time grid (guest view).
    await page.goto("/new");
    await page.getByTestId("quick-title").fill("Camping trip");
    await page.getByTestId("quick-mode-avail").click();
    // The single create flow picks the scope right here ("generally").
    await page.getByTestId("quick-scope-general").click();
    await page.getByTestId("quick-create").click();
    await page.getByTestId("event-title").waitFor();
    await page.getByTestId("preview-toggle").click(); // host → guest view
    await page.getByTestId("vote-first").waitFor();   // open poll: straight to voting, no RSVP gate
    await page.getByTestId("gp-cell-0-noon").click();
    for (const cell of ["gp-cell-5-evening", "gp-cell-6-afternoon", "gp-cell-6-evening"]) {
      await page.getByTestId(cell).click();
    }
    await page.getByTestId("gp-month-0").click();
    await page.screenshot({ path: `${OUT}/03-scheduler-general-poll.png`, fullPage: true, animations: "disabled" });

    // Feature: explicit date-based availability on the profile.
    await page.goto("/profile");
    await page.getByTestId("avail-edit").click();
    await page.getByTestId("availability-grid").waitFor();
    for (const c of ["avail-cell-2-noon", "avail-cell-5-morning"]) {
      await page.getByTestId(c).click();
    }
    for (const c of ["avail-cell-1-evening", "avail-cell-2-afternoon", "avail-cell-6-evening"]) {
      await page.getByTestId(c).click();
    }
    await page.screenshot({ path: `${OUT}/04-scheduler-availability.png`, fullPage: true, animations: "disabled" });

    // Feature: calendar view (connect via profile in stub mode, then the grid).
    await page.goto("/profile");
    if (await page.getByTestId("connect-google").isVisible().catch(() => false)) {
      await page.getByTestId("connect-google").click();
    }
    await page.goto("/calendars");
    await page.getByTestId("cal-month").waitFor();
    await page.screenshot({ path: `${OUT}/05-scheduler-calendars.png`, fullPage: true, animations: "disabled" });
  });
});

// The single create flow: title + either a fixed time or an availability poll.
// Type/cover/location are set later via edit-in-place, so seeding is just this.
async function createFixed(page: import("@playwright/test").Page, title: string, when: string) {
  await page.goto("/new");
  await page.getByTestId("quick-title").fill(title);
  await page.getByTestId("quick-mode-fixed").click();
  await page.getByTestId("quick-when").fill(when);
  await page.getByTestId("quick-create").click();
  await page.getByTestId("share-link").waitFor();
}

async function createAvailPoll(page: import("@playwright/test").Page, title: string) {
  await page.goto("/new");
  await page.getByTestId("quick-title").fill(title);
  await page.getByTestId("quick-mode-avail").click(); // week scope (default)
  await page.getByTestId("quick-create").click();
  await page.getByTestId("share-link").waitFor();
}
