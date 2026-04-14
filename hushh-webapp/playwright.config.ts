import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Configuration for Hushh Webapp (Kai)
 *
 * Run with:
 *   npx playwright test                    # all tests
 *   npx playwright test --project=chromium  # single browser
 *   npx playwright test --ui               # interactive mode
 *
 * Environment:
 *   BASE_URL - override the dev server URL (default: http://localhost:3000)
 *   CI       - set in GitHub Actions; disables retries and video recording
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "html",

  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],

  /* Start the dev server automatically when running locally */
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
