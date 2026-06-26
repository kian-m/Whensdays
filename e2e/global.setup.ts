import { clerkSetup } from "@clerk/testing/playwright";

// Exchanges Clerk keys for a testing token so Playwright can sign in without
// solving bot protection. Skipped in dev auth mode (hermetic, no Clerk).
export default async function globalSetup() {
  if (process.env.E2E_AUTH_MODE === "dev") return;
  await clerkSetup();
}
