import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

const DEV_AUTH = process.env.E2E_AUTH_MODE === "dev";

// Feature: the scheduler ("get-togethers"). Asserts behavior (create an event,
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
    await page.getByTestId("loc-host").click();
    await page.getByTestId("sched-fixed").click();
    await page.getByTestId("fixed-time").fill("2026-08-01T19:00");
    await page.getByTestId("create-event").click();

    // Lands on the event page in the host view (share link is host-only).
    await expect(page.getByTestId("event-title")).toHaveText(title);
    await expect(page.getByTestId("share-link")).toBeVisible();

    // Preview as a guest: RSVP, then answer the one-at-a-time preference Qs.
    await page.getByTestId("preview-toggle").click();
    await page.getByTestId("rsvp-going").click();
    await page.getByTestId("pref-input").fill("Vegetarian");
    await page.getByTestId("pref-next").click();
    await page.getByTestId("pref-input").fill("Italian");
    await page.getByTestId("pref-save").click();

    // Back in the host view, the guest's answer is summarized.
    await page.getByTestId("preview-toggle").click();
    await expect(page.getByText("Vegetarian")).toBeVisible();
  });

  test("create form visual baseline", async ({ page }) => {
    await ensureProfile(page);
    await page.getByTestId("new-event").click();
    // Deterministic state: a known type selected, inputs empty.
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("event-title").fill("");
    await expect(page.locator("form")).toHaveScreenshot("new-event-form.png");
  });
});
