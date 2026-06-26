import { defineConfig, devices } from "@playwright/test";

// Visual end-to-end tests. Every feature must ship with a spec here that
// asserts behavior AND a screenshot (toHaveScreenshot) so regressions are caught.
const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global.setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "blob" : "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Pin clock formatting so date/time rendering is stable across machines/CI.
    timezoneId: "UTC",
    locale: "en-US",
  },
  // Pin rendering so screenshots are deterministic across machines/CI.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
