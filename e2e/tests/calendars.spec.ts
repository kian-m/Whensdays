import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

const DEV_AUTH = process.env.E2E_AUTH_MODE === "dev";

// Feature: calendar import. Connecting Google (OAuth) and Apple (iCal URL) hit
// external providers, so this exercises the hermetic CALENDAR_MODE=stub path -
// connecting seeds a fake connection + fixed events. Only meaningful in the dev
// stack; skipped in prod-shaped Clerk runs.
//
// e2e-docker runs Playwright twice against the SAME persistent DB (baseline pass,
// then assertion pass), so each test uses its OWN dev user (?as=…) to stay
// independent - the snapshot test's user only ever links Google, keeping its
// visual baseline identical on both passes.
test.describe("calendars (import)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DEV_AUTH, "calendar import uses CALENDAR_MODE=stub, only in the hermetic dev stack");

  async function gotoCalendars(page: import("@playwright/test").Page, devUser: string) {
    await page.goto(`/?as=${devUser}`);
    await page.waitForSelector('[data-testid="setup-name"], [data-testid="new-event"]');
    if (await page.getByTestId("setup-name").isVisible()) {
      await page.getByTestId("setup-name").fill(devUser);
      await page.getByTestId("setup-handle").fill(devUser);
      await page.getByTestId("setup-save").click();
      await expect(page.getByTestId("new-event")).toBeVisible();
    }
    await page.goto("/profile");
    // Connection management lives on the Profile page; wait for the card to
    // finish loading before any non-waiting isVisible() checks.
    await expect(page.getByTestId("calendar-connections")).toBeVisible();
  }

  test("calendars page (empty state) visual baseline", async ({ page }) => {
    // A dedicated user that never connects - the empty page renders identically
    // on the baseline and assertion passes (no stateful connect/reload between).
    await gotoCalendars(page, "calempty");
    await expect(page.getByTestId("connect-google")).toBeVisible();
    await expect(page.getByTestId("connect-apple-open")).toBeVisible();
    // The personal feed card offers webcal subscribe + a copyable https URL.
    await expect(page.getByTestId("feed-card")).toBeVisible();
    const webcal = await page.getByTestId("feed-subscribe").getAttribute("href");
    expect(webcal).toMatch(/^webcal:\/\//);
    expect(webcal).toContain("/api/feed.ics?token=");
    // The feed itself: signed token -> VCALENDAR; garbage token -> 401.
    // (Relative fetch - the e2e origin differs from the baked APP_ORIGIN.)
    const token = webcal!.split("token=")[1];
    const feed = await page.request.get(`/api/feed.ics?token=${token}`);
    expect(feed.status()).toBe(200);
    expect(await feed.text()).toContain("BEGIN:VCALENDAR");
    const bad = await page.request.get("/api/feed.ics?token=garbage");
    expect(bad.status()).toBe(401);
    await expect(page.getByTestId("calendar-connections")).toHaveScreenshot("calendar-connections.png");
  });

  test("connect Google (stub) shows imported events", async ({ page }) => {
    await gotoCalendars(page, "calgoog");

    // Idempotent across the two passes: connect only if not already linked.
    if (await page.getByTestId("connect-google").isVisible().catch(() => false)) {
      await page.getByTestId("connect-google").click();
      // The stub redirects through /profile?connected=google, which lazy-loads
      // the Profile chunk and refetches connections - generous timeout, and the
      // connected state (Disconnect visible) is the invariant, not the toast.
    }
    await expect(page.getByTestId("disconnect-google")).toBeVisible({ timeout: 20000 });

    // The stub events (Aug 2026) show on the Calendars month view.
    await page.goto("/calendars");
    await expect(page.getByTestId("cal-month")).toBeVisible();
    while (!(await page.getByTestId("cal-title").textContent())?.includes("August 2026")) {
      await page.getByTestId("cal-next").click();
    }
    await expect(page.getByText("Dentist appointment").first()).toBeVisible();

    // View toggles + Today navigation work.
    await page.getByTestId("cal-view-week").click();
    await expect(page.getByTestId("cal-week")).toBeVisible();
    await page.getByTestId("cal-view-day").click();
    await expect(page.getByTestId("cal-day")).toBeVisible();
    const monthTitle = await page.getByTestId("cal-title").textContent();
    await page.getByTestId("cal-today").click();
    await expect(page.getByTestId("cal-title")).not.toHaveText(monthTitle ?? "");
  });

  test("connect Apple privately (CalDAV, stub)", async ({ page }) => {
    await gotoCalendars(page, "calpriv");

    // Apple CalDAV: app-specific password form (idempotent across passes).
    if (await page.getByTestId("connect-apple-caldav-open").isVisible().catch(() => false)) {
      await page.getByTestId("connect-apple-caldav-open").click();
      await page.getByTestId("apple-caldav-id").fill("demo@icloud.com");
      await page.getByTestId("apple-caldav-password").fill("xxxx-xxxx-xxxx-xxxx");
      await page.getByTestId("connect-apple-caldav").click();
    }
    await expect(page.getByTestId("disconnect-apple-caldav")).toBeVisible({ timeout: 20000 });

    // The stub caldav event lands on the month view (Aug 2026).
    await page.goto("/calendars");
    await expect(page.getByTestId("cal-month")).toBeVisible();
    while (!(await page.getByTestId("cal-title").textContent())?.includes("August 2026")) {
      await page.getByTestId("cal-next").click();
    }
    await expect(page.getByText("Yoga class").first()).toBeVisible();
  });

  test("connect Apple via a published iCal URL (stub)", async ({ page }) => {
    await gotoCalendars(page, "calapple");

    if (await page.getByTestId("connect-apple-open").isVisible().catch(() => false)) {
      await page.getByTestId("connect-apple-open").click();
      await page.getByTestId("apple-url").fill("webcal://p01.icloud.com/published/2/demo-calendar.ics");
      await page.getByTestId("connect-apple").click();
    }
    await expect(page.getByTestId("disconnect-apple")).toBeVisible();
    // The stub's Book club event (Aug 2026) shows on the calendar view.
    await page.goto("/calendars");
    await expect(page.getByTestId("cal-month")).toBeVisible();
    while (!(await page.getByTestId("cal-title").textContent())?.includes("August 2026")) {
      await page.getByTestId("cal-next").click();
    }
    await expect(page.getByText("Book club").first()).toBeVisible();
  });

  test("disconnect a calendar", async ({ page }) => {
    // Uses Apple (a paste-a-URL connect, no OAuth redirect). Connect, wait for
    // the write to land, then reload so the connected state renders on initial
    // load - deterministic, independent of the in-place refetch timing.
    await gotoCalendars(page, "caldisc");
    if (await page.getByTestId("connect-apple-open").isVisible().catch(() => false)) {
      await page.getByTestId("connect-apple-open").click();
      await page.getByTestId("apple-url").fill("webcal://p01.icloud.com/published/2/disc-calendar.ics");
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/calendar/apple") && r.ok()),
        page.getByTestId("connect-apple").click(),
      ]);
      await page.goto("/profile"); // connections card lives on Profile now
    }
    await expect(page.getByTestId("disconnect-apple")).toBeVisible();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/calendar/connections/apple_ical") && r.ok()),
      page.getByTestId("disconnect-apple").click(),
    ]);
    await expect(page.getByTestId("connect-apple-open")).toBeVisible();
  });

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
});
