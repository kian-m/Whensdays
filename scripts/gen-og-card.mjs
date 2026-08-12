// Renders the branded Open Graph card (apps/web/public/og-card.png) — the image
// phones show when a Whensdays invite link is shared. Run via `make og-card`
// (uses the Playwright container). Regenerate when the brand look changes.
//
// House Lights palette (docs/design/HOUSE-LIGHTS.md §2): plum stage + grain,
// cream ink, coral accent, the candy stripe as the one allowed gradient. No
// emoji (§1.1), no gradient text fill on the headline (§1.2 - gradients are
// reserved for --stripe/skeleton/theme washes, not interactive-adjacent type).
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";

// Inline the real logo (same asset as the favicon) as a data URL.
const logo = `data:image/svg+xml;base64,${readFileSync("apps/web/public/icon.svg").toString("base64")}`;

// Same fractal-noise grain as --grain in styles.css / the comp.
const grain =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #f2e9dc;
    background: #1a1424 url("${grain}");
    padding: 0 84px 76px; display: flex; flex-direction: column; justify-content: space-between;
  }
  .stripe { height: 8px; margin: 0 -84px; background: linear-gradient(90deg, #ee6c4d 0 25%, #e9a13b 25% 50%, #3aa38b 50% 75%, #f8e3c9 75% 100%); }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 800; letter-spacing: -0.01em; margin-top: 64px; }
  .dot { width: 44px; height: 44px; background: url("${logo}") center/contain no-repeat; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 92px; letter-spacing: -0.03em; line-height: 0.98; max-width: 15ch; }
  h1 b { color: #ee6c4d; font-weight: 700; }
  .sub { margin-top: 22px; font-size: 34px; color: #a596b4; }
  .row { display: flex; gap: 14px; }
  .chip { font-size: 28px; font-weight: 600; color: #f2e9dc; border: 2px solid #3a2f4d; border-radius: 10px; padding: 12px 22px; }
</style></head><body>
  <div class="stripe"></div>
  <div class="brand"><span class="dot"></span> Whensdays</div>
  <div>
    <h1>You're <b>invited.</b></h1>
    <div class="sub">Poll the group, lock the best time - one link, no account needed.</div>
  </div>
  <div class="row">
    <span class="chip">Dinner</span><span class="chip">Movie night</span>
    <span class="chip">Camping</span><span class="chip">Party</span>
  </div>
</body></html>`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
writeFileSync("apps/web/public/og-card.png", buf);
await b.close();
console.log("wrote apps/web/public/og-card.png");
