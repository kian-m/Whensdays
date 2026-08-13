import { test, expect } from "@playwright/test";

// One-off: capture the "Plan the next one" series re-poll entry from the
// running stack. Needs a SERIES_ID for a scheduled 2+ date series whose last
// occurrence is <21 days out, viewed as the host (re-poll is manager-only).
// Guarded by CAPTURE_SERIES=1. Writes to ./docs/marketing on the host.
const OUT = process.env.DOCS_OUT || "/out";
const ID = process.env.SERIES_ID || "";

test.describe("capture series re-poll", () => {
  test.skip(!process.env.CAPTURE_SERIES, "series-capture mode only");
  test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test("shoot re-poll card", async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem("whensdays.a2hs", "1"); } catch { /* ignore */ } });
    await page.addInitScript(() => {
      const css = '.pill[title^="dev user"]{display:none!important}';
      const add = () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
      if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
    });
    const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}`, animations: "disabled" });

    // Host view — the SeriesCard + re-poll button only render for a manager.
    await page.goto(`/e/${ID}?as=demo-user`);
    await page.waitForSelector('[data-testid="series-repoll"]');
    await page.evaluate(() =>
      document.querySelector('[data-testid="series"]')?.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await expect(page.getByTestId("series-repoll")).toBeVisible();
    await shot("05-repoll.png");
  });
});
