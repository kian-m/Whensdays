import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

const DEV_AUTH = process.env.E2E_AUTH_MODE === "dev";

// Feature: Notes. Asserts behavior (create -> appears) AND a visual baseline.
// This is the template every new feature follows. In prod-shaped runs it signs
// in via Clerk; in hermetic dev runs auth is stubbed so no Clerk is needed.
test.describe("notes", () => {
  test.beforeEach(async ({ page }) => {
    if (DEV_AUTH) return;
    await setupClerkTestingToken({ page });
    await page.goto("/"); // load Clerk before signing in
    await clerk.signIn({
      page,
      signInParams: {
        strategy: "password",
        identifier: process.env.E2E_CLERK_USER_USERNAME!,
        password: process.env.E2E_CLERK_USER_PASSWORD!,
      },
    });
  });

  test("create a note and see it in the list", async ({ page }) => {
    await page.goto("/");

    const unique = `note-${test.info().testId}`;
    await page.getByTestId("note-input").fill(unique);
    await page.getByTestId("add-note").click();

    // Behavior: the new note shows up.
    await expect(page.getByTestId("note-list")).toContainText(unique);

    // Visual: snapshot the stable header+form region (the list grows across
    // runs, so we baseline a deterministic part of the UI). Clear input first.
    await page.getByTestId("note-input").fill("");
    await expect(page.locator("form")).toHaveScreenshot("notes-form.png");
  });
});
