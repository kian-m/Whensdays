// Renders the branded Open Graph card (apps/web/public/og-card.png) — the image
// phones show when a Whensdays invite link is shared. Run via `make og-card`
// (uses the Playwright container). Regenerate when the brand look changes.
import { chromium } from "@playwright/test";
import { writeFileSync } from "fs";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #f2f0f7;
    background:
      radial-gradient(900px 500px at 78% -10%, rgba(123,116,255,0.45), transparent 60%),
      radial-gradient(700px 500px at 0% 120%, rgba(63,191,136,0.18), transparent 55%),
      #131218;
    padding: 76px 84px; display: flex; flex-direction: column; justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 800; letter-spacing: -0.01em; }
  .dot { width: 26px; height: 26px; border-radius: 50%; background: #7b74ff; box-shadow: 0 0 28px rgba(123,116,255,0.9); }
  h1 { font-size: 92px; font-weight: 850; letter-spacing: -0.035em; line-height: 0.98; max-width: 15ch; }
  h1 b { background: linear-gradient(120deg, #f2f0f7 20%, #7b74ff 110%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .sub { margin-top: 22px; font-size: 34px; color: #b7b3c6; }
  .row { display: flex; gap: 14px; }
  .chip { font-size: 30px; font-weight: 700; background: rgba(123,116,255,0.16); color: #cfcbe6; border-radius: 999px; padding: 12px 22px; }
</style></head><body>
  <div class="brand"><span class="dot"></span> Whensdays</div>
  <div>
    <h1>You're <b>invited.</b></h1>
    <div class="sub">Pick a time, drop one link — no account needed to join.</div>
  </div>
  <div class="row">
    <span class="chip">🍽️ Dinner</span><span class="chip">🎬 Movie night</span>
    <span class="chip">⛺ Camping</span><span class="chip">🎉 Party</span>
  </div>
</body></html>`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
writeFileSync("apps/web/public/og-card.png", buf);
await b.close();
console.log("wrote apps/web/public/og-card.png");
