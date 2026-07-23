import { test, expect } from "@playwright/test";

// Generates the README/gallery feature screenshots from the live app. Runs ONLY
// in docs mode (DOCS_SHOTS=1, set by `make docs-shots`); skipped during normal
// E2E. Add a capture here for every new feature/page so the docs stay current.
const OUT = process.env.DOCS_OUT || "/out";

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
    await createFixed(page, "Sunday matinee", "movie", "2026-08-09T14:00");
    await createFixed(page, "Rooftop drinks", "drinks", "2026-08-14T18:30");
    await createFixed(page, "Friday dinner", "dinner", "2026-08-07T19:30");
    await createPoll(page, "Camping weekend", "camping", ["2026-08-12T19:00", "2026-08-13T19:00"]);

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
    await page.getByTestId("event-title").fill("Camping trip");
    await pickType(page, "camping");
    await page.getByTestId("sched-general").click();
    await page.getByTestId("create-event").click();
    // A general poll ships with no scope; the host finishes setup on the event
    // page (the scope picker moved out of the wizard).
    await page.getByTestId("scope-general").click();
    await page.getByTestId("poll-setup-save").click();
    await expect(page.getByTestId("general-setup")).toBeHidden();
    await page.getByTestId("preview-toggle").click(); // host → guest view
    await page.getByTestId("rsvp-going").click();      // voting is gated behind the RSVP
    await page.getByTestId("vote-summary").click();    // …and collapsed by default
    for (const cell of ["gp-cell-5-evening", "gp-cell-6-afternoon", "gp-cell-6-evening", "gp-cell-0-noon"]) {
      await page.getByTestId(cell).click();
    }
    await page.getByTestId("gp-month-0").click();
    await page.screenshot({ path: `${OUT}/03-scheduler-general-poll.png`, fullPage: true, animations: "disabled" });

    // Feature: explicit date-based availability on the profile.
    await page.goto("/profile");
    await page.getByTestId("avail-edit").click();
    await page.getByTestId("availability-grid").waitFor();
    for (const c of ["avail-cell-1-evening", "avail-cell-2-noon", "avail-cell-2-afternoon", "avail-cell-5-morning", "avail-cell-6-evening"]) {
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

// The 5 primary type chips on Screen 1; every other preset lives in the "More"
// sheet. Mirrors PRIMARY_TYPES in NewEvent.tsx.
const PRIMARY_TYPES = ["practice", "show", "party", "dinner", "drinks"];
async function pickType(page: import("@playwright/test").Page, type: string) {
  if (PRIMARY_TYPES.includes(type)) {
    await page.getByTestId(`type-${type}`).click();
  } else {
    await page.getByTestId("type-more").click();
    await page.getByTestId(`sheet-type-${type}`).click();
  }
}

async function createFixed(page: import("@playwright/test").Page, title: string, type: string, when: string) {
  await page.goto("/new");
  await page.getByTestId("event-title").fill(title);
  await pickType(page, type);
  await page.getByTestId("sched-fixed").click();
  await page.getByTestId("fixed-time").fill(when);
  await page.getByTestId("create-event").click();
  await page.getByTestId("share-link").waitFor();
}

async function createPoll(page: import("@playwright/test").Page, title: string, type: string, times: string[]) {
  await page.goto("/new");
  await page.getByTestId("event-title").fill(title);
  await pickType(page, type);
  await page.getByTestId("sched-poll").click();
  for (let i = 0; i < times.length; i++) {
    if (i > 1) await page.getByTestId("add-option").click(); // 2 rows exist by default
    await page.getByTestId(`poll-option-${i}`).fill(times[i]);
  }
  await page.getByTestId("create-event").click();
  await page.getByTestId("share-link").waitFor();
}
