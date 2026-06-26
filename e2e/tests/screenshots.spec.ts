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
    await createPoll(page, "Trivia night", "trivia", ["2026-08-12T19:00", "2026-08-13T19:00"]);

    // Feature: home dashboard (this is the gallery home-page screenshot).
    await page.goto("/");
    await page.getByTestId("event-row").first().waitFor();
    await page.screenshot({ path: `${OUT}/01-scheduler-home.png`, fullPage: true });

    // Feature: event page (host view) with the invite link + management.
    await page.getByTestId("event-row").first().click();
    await page.getByTestId("share-link").waitFor();
    await page.screenshot({ path: `${OUT}/02-scheduler-event.png`, fullPage: true });
  });
});

async function createFixed(page: import("@playwright/test").Page, title: string, type: string, when: string) {
  await page.goto("/new");
  await page.getByTestId("event-title").fill(title);
  await page.getByTestId(`type-${type}`).click();
  await page.getByTestId("sched-fixed").click();
  await page.getByTestId("fixed-time").fill(when);
  await page.getByTestId("create-event").click();
  await page.getByTestId("share-link").waitFor();
}

async function createPoll(page: import("@playwright/test").Page, title: string, type: string, times: string[]) {
  await page.goto("/new");
  await page.getByTestId("event-title").fill(title);
  await page.getByTestId(`type-${type}`).click();
  await page.getByTestId("sched-poll").click();
  for (let i = 0; i < times.length; i++) {
    if (i > 0) await page.getByTestId("add-option").click();
    await page.getByTestId(`poll-option-${i}`).fill(times[i]);
  }
  await page.getByTestId("create-event").click();
  await page.getByTestId("share-link").waitFor();
}
