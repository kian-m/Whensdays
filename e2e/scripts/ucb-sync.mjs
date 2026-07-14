// Scrape UCB LA's improv listings and sync them into a Whensdays group.
//
// UCB sits behind a Cloudflare JS challenge that blocks plain HTTP and
// headless browsers, so this runs a REAL (headed) Chromium via Playwright -
// on CI wrap it in xvfb-run. It extracts every upcoming show card, then POSTs
// the parsed list to the API's CRON_KEY-gated /api/cron/ucb-sync, which owns
// all the matching/add/retime/cancel logic (see apps/api/ucbsync.go). Titles
// that don't already exist in the group are ignored server-side, so scraping
// broadly is safe.
//
// Env: CRON_KEY (required), UCB_GROUP_ID (required),
//      APP_ORIGIN (default https://whensdays.com)
// Flags: --dry-run  print the payload instead of POSTing.
//
// Run from e2e/ (Playwright lives here): node scripts/ucb-sync.mjs

import { chromium } from "@playwright/test";

// No comedy-type filter: the group also tracks sketch (Sketch Jam), and the
// server ignores titles the group doesn't already have.
const LISTING = "https://ucbcomedy.com/shows/los-angeles/";
const ORIGIN = process.env.APP_ORIGIN || "https://whensdays.com";
const DRY = process.argv.includes("--dry-run");

// Venue token on each card -> the address our events use.
const VENUES = {
  "LA - FRANKLIN": "UCB Franklin, Los Angeles, CA",
  "LA - ANNEX": "1925 N Bronson Ave, Los Angeles, CA",
};

const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };

// "Monday, July 13, 2026 @ 5:30 PM" -> "2026-07-13 17:30" (venue-local time;
// the server localizes with America/Los_Angeles).
function parseWhen(line) {
  const m = line.match(/^\w+, (\w+) (\d{1,2}), (\d{4}) @ (\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return null;
  const [, mon, day, year, hh, mm, ap] = m;
  const month = MONTHS[mon];
  if (!month) return null;
  let h = Number(hh) % 12;
  if (ap === "PM") h += 12;
  const p2 = (n) => String(n).padStart(2, "0");
  return `${year}-${p2(month)}-${p2(day)} ${p2(h)}:${mm}`;
}

const browser = await chromium.launch({ channel: "chromium", headless: false });
const page = await (await browser.newContext()).newPage();
try {
  await page.goto(LISTING, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // The Cloudflare challenge resolves itself in a real browser; the cards
  // appearing is the signal that we're through.
  await page.waitForSelector("article.wpgb-card", { timeout: 60_000 });

  // Exhaust the "Load more (N)" pager so the payload covers the full horizon.
  for (let i = 0; i < 30; i++) {
    const more = page.locator("button.wpgb-load-more");
    if (!(await more.count()) || !(await more.first().isVisible())) break;
    const before = await page.locator("article.wpgb-card").count();
    await more.first().click();
    await page
      .waitForFunction((n) => document.querySelectorAll("article.wpgb-card").length > n, before, { timeout: 20_000 })
      .catch(() => {}); // pager exhausted mid-click
    if ((await page.locator("article.wpgb-card").count()) === before) break;
  }

  const cards = await page.$$eval("article.wpgb-card", (arts) =>
    arts.map((a) => a.innerText.split("\n").map((l) => l.trim()).filter(Boolean)),
  );
  const shows = [];
  for (const lines of cards) {
    // Card text shape: when | venue | category | title | blurb… | Buy Now
    if (lines.length < 4) continue;
    const starts = parseWhen(lines[0]);
    if (!starts) continue;
    shows.push({ title: lines[3], starts, venue: VENUES[lines[1]] ?? lines[1] });
  }
  if (shows.length === 0) throw new Error("parsed 0 shows - the page layout changed or the challenge blocked us");
  console.log(`parsed ${shows.length} shows (${new Set(shows.map((s) => s.title)).size} titles)`);

  if (DRY) {
    console.log(JSON.stringify(shows, null, 2));
  } else {
    const { CRON_KEY, UCB_GROUP_ID } = process.env;
    if (!CRON_KEY || !UCB_GROUP_ID) throw new Error("CRON_KEY and UCB_GROUP_ID are required (or use --dry-run)");
    const res = await fetch(`${ORIGIN}/api/cron/ucb-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cron-Key": CRON_KEY },
      body: JSON.stringify({ group_id: UCB_GROUP_ID, shows }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`sync failed: ${res.status} ${body}`);
    console.log("synced:", body);
  }
} finally {
  await browser.close();
}
