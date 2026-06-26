import { test } from "@playwright/test";

// Generates the README feature screenshots from the live app. Runs ONLY in docs
// mode (DOCS_SHOTS=1, set by `make docs-shots`); skipped during normal E2E.
// Add a capture here for every new feature/page so the README stays current.
const OUT = process.env.DOCS_OUT || "/out";

test.describe("docs screenshots", () => {
  test.skip(!process.env.DOCS_SHOTS, "docs screenshot mode only");
  test.use({ viewport: { width: 900, height: 600 } });

  test("capture feature pages", async ({ page }) => {
    // Feature: empty Notes page (initial state).
    await page.goto("/");
    await page.getByTestId("note-input").waitFor();
    await page.screenshot({ path: `${OUT}/01-notes-empty.png`, fullPage: true });

    // Feature: add notes -> populated list.
    for (const body of ["Buy groceries", "Ship clSandbox", "Walk the dog"]) {
      await page.getByTestId("note-input").fill(body);
      await page.getByTestId("add-note").click();
      await page.getByTestId("note-list").getByText(body, { exact: true }).waitFor();
    }
    await page.getByTestId("note-input").fill("");
    await page.screenshot({ path: `${OUT}/02-notes-list.png`, fullPage: true });
  });
});
