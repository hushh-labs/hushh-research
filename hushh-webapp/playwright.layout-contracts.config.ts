import { defineConfig, devices } from "@playwright/test";

/**
 * Layout-contract config — geometry assertions that need NO running app.
 *
 * These specs answer one question: "does this markup, under this stylesheet,
 * fit at this width". That is answerable from the compiled CSS alone, so they
 * render with `page.setContent()` and never navigate to a URL.
 *
 * The main `playwright.config.ts` boots `npm run dev` through its `webServer`
 * block, which the e2e journey specs genuinely need. Inheriting it here would
 * make a 6-second geometry check wait on a Next dev server -- slow everywhere,
 * and effectively a hang on a machine where the repo sits in an iCloud-synced
 * folder (FileProvider throttles every build read). So this config starts no
 * server at all, which is also why these contracts can run as a fast required
 * gate while the journey specs need REVIEWER_UID and a vault passphrase.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.contract\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "line",
  use: {
    trace: "on-first-retry",
    // Failure diagnostics only. A passing run never captures or compares an
    // image -- the contracts are geometry assertions, not screenshot review.
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
