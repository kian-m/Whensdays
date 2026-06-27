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

  test("create a general-availability poll and respond", async ({ page }) => {
    await ensureProfile(page);

    const title = `Hangout ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-other").click();
    await page.getByTestId("sched-general").click();
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
    await expect(page.getByText("Evening")).toBeVisible();
  });

  test("create form visual baseline", async ({ page }) => {
    await ensureProfile(page);
    await page.getByTestId("new-event").click();
    // Deterministic state: a known type selected, inputs empty.
    await page.getByTestId("type-dinner").click();
    await page.getByTestId("event-title").fill("");
    await expect(page.locator("form")).toHaveScreenshot("new-event-form.png");
  });

  test("specific-times poll: vote and finalize", async ({ page }) => {
    await ensureProfile(page);

    const title = `Movie ${test.info().testId}`;
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill(title);
    await page.getByTestId("type-movie").click();
    await page.getByTestId("sched-poll").click();
    await page.getByTestId("poll-option-0").fill("2026-08-01T19:00");
    await page.getByTestId("add-option").click();
    await page.getByTestId("poll-option-1").fill("2026-08-02T19:00");
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
    await page.getByTestId("profile-name").fill("Demo Host");
    await page.getByTestId("save-profile").click();
    // Explicit calendar: tomorrow evening, day-after noon.
    await page.getByTestId("avail-cell-1-evening").click();
    await page.getByTestId("avail-cell-2-noon").click();
    await page.getByTestId("save-availability").click();
    await expect(page.getByText("Availability saved ✓")).toBeVisible();
  });

  test("upload a profile photo", async ({ page }) => {
    await ensureProfile(page);
    await page.goto("/profile");
    // 1x1 PNG; the client resizes it to a JPEG data URL before saving.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.getByTestId("avatar-file").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
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
      await ben.getByTestId("avail-cell-2-afternoon").click();
      await ben.getByTestId("save-availability").click();
      await expect(ben.getByText("Availability saved ✓")).toBeVisible();

      await ensureUser(amy, "amy", "Amy", "amy");
      await amy.goto("/friends");
      await amy.getByTestId("friend-handle").fill("ben");
      await amy.getByTestId("add-friend").click();
      await expect(amy.getByText("Request sent ✓")).toBeVisible(); // request persisted

      // Ben accepts (only if a request is pending — keeps the run idempotent),
      // then wait until Amy shows as an accepted friend so the round-trip is done.
      await ben.goto("/friends");
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
