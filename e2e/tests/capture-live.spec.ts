import { test } from "@playwright/test";

// One-off: capture an ALREADY-SEEDED event (by EVENT_ID) from the running
// stack - no create/seed. Used to shoot an event after editing it by hand
// (e.g. a real Klipy cover). Writes to ./docs/marketing on the host.
const OUT = process.env.DOCS_OUT || "/out";
const ID = process.env.EVENT_ID || "";

test.describe("capture live event", () => {
  test.skip(!process.env.CAPTURE_LIVE, "live-capture mode only");
  test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test("shoot existing event", async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem("whensdays.a2hs", "1"); } catch { /* ignore */ } });
    await page.addInitScript(() => {
      const css = '.pill[title^="dev user"]{display:none!important}';
      const add = () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
      if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
    });
    const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}`, animations: "disabled" });
    const scrollTo = (sel: string) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), sel);

    // Hero (guest view, top).
    await page.goto(`/e/${ID}?as=maya`);
    await page.waitForSelector('[data-testid="event-title"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400); // let the cover image load
    await shot("04-hero.png");

    // Heatmap (host results view).
    await page.goto(`/e/${ID}?as=demo-user`);
    await page.waitForSelector('[data-testid="gr-week-heat"]');
    await scrollTo('[data-testid="general-results"]');
    await page.waitForTimeout(150);
    await shot("02-heatmap.png");

    // Date being selected.
    const cells = await page.$$eval('[data-testid^="grw-pick-"]',
      (els) => (els as HTMLElement[]).map((e) => e.dataset.testid as string));
    const hot = cells.filter((c) => c.endsWith("-evening")).slice(0, 2);
    for (const c of hot) await page.getByTestId(c).click();
    await page.waitForSelector('[data-testid="picked-cells"] button');
    await scrollTo('[data-testid="general-results"]');
    await page.waitForTimeout(150);
    await shot("03-date-selected.png");

    // Who's-in (guest top).
    await page.goto(`/e/${ID}?as=maya`);
    await page.waitForSelector('[data-testid="whos-in"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("01-whos-in.png");
  });
});
