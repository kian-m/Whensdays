import { test } from "@playwright/test";

// Marketing screenshots: seeds a RICH scenario (many people RSVP'd, a full
// availability heatmap, a date being picked) and captures clean crops for
// social posts. Runs only in MARKETING_SHOTS mode (make marketing-shots),
// against the hermetic dev stack. Writes PNGs to ./docs/marketing on the host.
const OUT = process.env.DOCS_OUT || "/out";

import { readFileSync } from "fs";

// First-name-only people (no last names) so the guest list reads naturally.
const PEOPLE: [string, string][] = [
  ["maya", "Maya"], ["jordan", "Jordan"], ["sam", "Sam"],
  ["riley", "Riley"], ["ava", "Ava"], ["noah", "Noah"],
  ["zoe", "Zoe"], ["liam", "Liam"], ["emma", "Emma"],
];

test.describe("marketing screenshots", () => {
  test.skip(!process.env.MARKETING_SHOTS, "marketing screenshot mode only");
  test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test("capture group scenario", async ({ page }) => {
    // Suppress the add-to-homescreen prompt (fires on phone-width event pages
    // after a first create; it would overlay the shots and block clicks).
    await page.addInitScript(() => { try { localStorage.setItem("whensdays.a2hs", "1"); } catch { /* ignore */ } });
    // Hide the dev-user badge ("DEV: MAYA") on every page load - it only exists
    // in dev/E2E mode and must never appear in marketing images. Injected via
    // init script so it survives navigations; no app change.
    await page.addInitScript(() => {
      // Prefix match avoids the "…" (U+2026) in the full title, which doesn't
      // escape cleanly in a CSS attribute selector.
      const css = '.pill[title^="dev user"]{display:none!important}';
      const add = () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
      if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
    });
    // Host profile.
    await page.goto("/");
    await page.waitForSelector('[data-testid="setup-name"], [data-testid="new-event"]');
    if (await page.getByTestId("setup-name").isVisible().catch(() => false)) {
      await page.getByTestId("setup-name").fill("Alex Rivera");
      await page.getByTestId("setup-handle").fill("alex");
      await page.getByTestId("setup-save").click();
    }

    // Create a week-scope availability poll (concrete dates x dayparts heatmap).
    await page.getByTestId("new-event").click();
    await page.getByTestId("event-title").fill("Board game night 🎲");
    await page.getByTestId("type-party").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("loc-host").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("sched-general").click();
    await page.getByTestId("scope-week").click();
    await page.getByTestId("wiz-next").click();
    await page.getByTestId("create-event").click();
    await page.waitForSelector('[data-testid="event-title"]');
    const id = page.url().split("/e/")[1];

    // Give the event a party GIF cover (generated animated data:image/gif; the
    // hermetic stack has no real Klipy). Re-PUT the event with photo_url set.
    const coverGif = readFileSync("/work/marketing-cover.txt", "utf8").trim();
    await page.evaluate(async ({ id, cover }) => {
      const h = { "Content-Type": "application/json", "X-Dev-User": "demo-user" };
      const d = await (await fetch(`/api/events/${id}`, { headers: h })).json();
      const e = d.event;
      await fetch(`/api/events/${id}`, {
        method: "PUT", headers: h,
        body: JSON.stringify({
          title: e.title, description: e.description, location_mode: e.location_mode,
          location_address: e.location_address, photo_url: cover, theme: e.theme,
          visibility: e.visibility, topic: e.topic, city: e.city,
        }),
      });
    }, { id, cover: coverGif });

    // Derive the 7 window dates from the event's created_at, replicating the
    // client's daysFromDate() in the SAME browser TZ (so votes land on the
    // exact cells the grid renders). Done in-page as the host (demo-user).
    const dates: string[] = await page.evaluate(async (id) => {
      const ev = await (await fetch(`/api/events/${id}`, { headers: { "X-Dev-User": "demo-user" } })).json();
      const s = new Date(ev.event.created_at);
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
    }, id);

    // Seed everyone: RSVP going + availability votes that build a heat gradient
    // (evenings hottest, a few scattered daytime picks for texture).
    await page.evaluate(async ({ id, people, dates }) => {
      for (let i = 0; i < people.length; i++) {
        const [handle, name] = people[i];
        const h = { "Content-Type": "application/json", "X-Dev-User": handle };
        await fetch("/api/profile", { method: "PUT", headers: h, body: JSON.stringify({ display_name: name, handle }) });
        await fetch(`/api/events/${id}/rsvp`, { method: "POST", headers: h, body: JSON.stringify({ rsvp: "going" }) });
        const slots: { day: string; daypart: string }[] = [];
        slots.push({ day: dates[2], daypart: "evening" }, { day: dates[4], daypart: "evening" });
        if (i % 3 !== 0) slots.push({ day: dates[3], daypart: "evening" }, { day: dates[2], daypart: "afternoon" });
        if (i % 2 === 0) slots.push({ day: dates[1], daypart: "night" }, { day: dates[5], daypart: "morning" });
        if (i < 4) slots.push({ day: dates[4], daypart: "afternoon" });
        await fetch(`/api/events/${id}/general-votes`, { method: "POST", headers: h, body: JSON.stringify({ day_slots: slots }) });
      }
    }, { id, people: PEOPLE, dates });

    // All shots are full VIEWPORT frames (proper in-context phone screens, not
    // bare element crops), scrolled so the hero feature sits high under the
    // branded header. `animations: disabled` freezes the drifting-sky bg.
    const shot = (name: string) => page.screenshot({ path: `${OUT}/${name}`, animations: "disabled" });
    const scrollTo = (sel: string) =>
      page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), sel);

    // SHOT 1 - many people in the event: guest view, WhosIn facepile at the top.
    await page.goto(`/e/${id}?as=maya`);
    await page.waitForSelector('[data-testid="whos-in"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("01-whos-in.png");

    // SHOT 2 - the availability heatmap: host results view, heatmap framed.
    await page.goto(`/e/${id}?as=demo-user`);
    await page.waitForSelector('[data-testid="gr-week-heat"]');
    await scrollTo('[data-testid="general-results"]');
    await page.waitForTimeout(150);
    await shot("02-heatmap.png");

    // SHOT 3 - a date being selected: tap the two hottest cells, they become
    // picked chips; keep the heatmap + picks both in frame.
    await page.getByTestId(`grw-pick-${dates[2]}-evening`).click();
    await page.getByTestId(`grw-pick-${dates[4]}-evening`).click();
    await page.waitForSelector('[data-testid="picked-cells"] button');
    await scrollTo('[data-testid="general-results"]');
    await page.waitForTimeout(150);
    await shot("03-date-selected.png");

    // SHOT 4 - the event hero (guest view, top): title, cover, hosted-by,
    // who's-in - the whole story above the fold.
    await page.goto(`/e/${id}?as=maya`);
    await page.waitForSelector('[data-testid="event-title"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("04-hero.png");
  });
});
