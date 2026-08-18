import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL || "http://localhost:3000";
const basePort = new URL(baseURL).port || "3000";

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
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The product ships inside an iOS WKWebView, so Safari's engine is the
      // one that matters for layout contracts -- Chromium passing proves
      // nothing about the shipped container.
      //
      // Scoped to the specs written against it. The existing suite has never
      // run on WebKit and two of its assertions do not hold there yet (the
      // root layout's `interactive-widget` viewport key, which WebKit logs as
      // an error, and a profile redirect that behaves differently). Widening
      // this project to `e2e/**` would turn those red without fixing them.
      // Opt specs in as they are made WebKit-clean.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      // `gemini-endpoint-fields.layout` is opted in deliberately and is the
      // reason this project matters: a native <select> under WebKit's
      // `appearance: menulist` ignores the author's border-radius, so the
      // radius defect it covers is INVISIBLE in Chromium. A Chromium-only run
      // passes the broken control.
      // `save-location-sheet.layout` is opted in for the same reason: its step
      // rail is measured through a canvas, and the sheet it guards is a
      // first-run iOS surface. A colour contract that only ever ran on
      // Chromium proves nothing about the container people actually launch.
      // `one-intro-welcome.layout` is opted in because it is a `svh` contract:
      // Safari is the engine whose collapsing browser chrome makes `svh` and
      // `dvh` disagree, so a Chromium-only pass proves nothing about whether
      // the welcome screen scrolls on the phone people actually hold.
      // `auth-sign-in.layout` is opted in because sign-in is the first screen
      // every new person sees and the app ships inside an iOS WKWebView: a
      // Chromium-only pass proves nothing about the container they launch.
      testMatch:
        /(circle-join-responsive-contract|auth-sign-in\.layout|connect-circle-cta\.layout|one-location-requests-sent-row\.layout|one-location-duration-ladder\.layout|gemini-endpoint-fields\.layout|feed-needs-you-row\.layout|one-location-tab-strip\.layout|save-location-sheet\.layout|app-shell-top-clearance\.layout|app-shell-bottom-clearance\.layout|one-intro-welcome\.layout)\.spec\.ts/,
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
        command: `npm run dev -- --port ${basePort}`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
