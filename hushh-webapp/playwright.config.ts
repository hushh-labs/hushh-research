import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL || "http://localhost:3000";
const basePort = new URL(baseURL).port || "3000";

/**
 * Worker count under CI. One worker unless PLAYWRIGHT_WORKERS names a positive
 * integer; the browser leg of Web Targeted Contracts sets it, because the
 * layout packs spent ~11 minutes of a ~13-minute lane running one test at a
 * time on a 4-vCPU runner. Every layout spec builds its fixture in its own
 * mkdtemp directory and any server it starts binds port 0, so workers share
 * nothing. A script that passes `--workers=1` (the Next dev-server pack) still
 * wins, since the CLI overrides this. A malformed value fails loudly rather
 * than silently falling back.
 */
function ciWorkers(): number {
  const raw = process.env.PLAYWRIGHT_WORKERS?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`PLAYWRIGHT_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

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
  workers: process.env.CI ? ciWorkers() : undefined,
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
      // `contact-invitation-sheet.layout` is opted in for the same reason: it
      // measures a keyboard-lifted bottom sheet whose list collapsed on iPhones.
      // `save-location-sheet.layout` is opted in because the surface it
      // measures is a bottom sheet that people meet on an iPhone. A Chromium
      // pass says nothing about whether `dvh` inside a `clamp()`, or a sheet
      // pinned to `bottom-[var(--kb-height)]`, behaves the same in the engine
      // the app actually ships in.
      // `one-location-map-consent-panel.layout` is opted in for the same
      // reason: Your Map is the screen people meet on a phone, and the panel
      // it measures is the surface an iPhone's home indicator sits under. The
      // fixture is self-contained -- no app shell, so neither of the two
      // known WebKit failures above can reach it.
      // `connect-sticky-header.layout` is opted in because Connect is a
      // phone screen first, and `position: sticky` inside a scroll
      // container with its own top spacer is where the two engines have
      // historically disagreed. Its fixture builds its own shell, so
      // neither of the two known WebKit failures above can reach it.
      // `one-location-flow-action-footer.layout` is opted in because what it
      // measures IS a WebKit behaviour: `--kb-height` is published only when a
      // real on-screen keyboard opens, which happens in the WKWebView the app
      // ships in. Its fixture builds its own shell, so the two known failures
      // above cannot reach it either.
      // `agent-surface-model-authority.layout` is opted in because Agent Chat's
      // header is a phone screen first, and the claim it measures -- which
      // agent is answering -- is the one an owner reads on an iPhone. Its
      // fixture builds its own document, so neither of the two known WebKit
      // failures above can reach it.
      // `one-voice-panel.layout` is opted in because the live voice dock ships
      // in a WKWebView; its source-coupled fixture is self-contained and does
      // not exercise either of the known app-shell WebKit failures above.
      // `text-attachment-viewer.layout` is opted in because the pasted-text
      // sheet, its own scroll box and the scroll after Send are read on an
      // iPhone; its fixture builds its own document.
      // `settings-row-surface.layout` is opted in because a row's single
      // full-width surface, the press that falls through its content and the
      // nested checkbox beside it are tapped on an iPhone first.
      // `consent-center-row.layout` is opted in because the Requests row's
      // ✗ / ✓ targets and its row button are tapped on an iPhone.
      // `shared-with-you-card.layout` is opted in because the secure card is
      // read on an iPhone first: its Hide and Copy targets, and the ask rows'
      // keyboard and 44px targets, are measured in the engine the app ships in.
      // Its fixture builds its own document.
      // `chat-onboarding.layout` is opted in because selecting text on the
      // person's own accent bubble reads differently per engine, and the one
      // that matters is the WKWebView the app ships in. Its fixture builds its
      // own document.
      testMatch: [
        // The shared voice/text dock and keyboard clearance ship in WKWebView.
        /bottom-chrome-width\.layout\.spec\.ts/,
        /connect-page-grid\.layout\.spec\.ts/,
        /first-connect-insights\.layout\.spec\.ts/,
        /chat-onboarding\.layout\.spec\.ts/,
        // agent-markdown: One's answers are read on an iPhone first; the code
        // and table scroll boxes, 24px link targets and chip baselines are
        // measured in the engine the app ships in. Own document.
        /agent-markdown\.layout\.spec\.ts/,
        // press-ripple: the md-ripple on pointerdown, no press scale, and the
        // reduced-motion layer are felt on an iPhone first; own document.
        /press-ripple\.layout\.spec\.ts/,
        // agent-queued-stack: the queue above the composer is used while One
        // replies on an iPhone, so its grid is measured in WebKit; own document.
        /agent-queued-stack\.layout\.spec\.ts/,
        // agent-chat-slow-notice: the slow-reply notice under the status bar's
        // safe area and clear of the composer, read on an iPhone; own document.
        /agent-chat-slow-notice\.layout\.spec\.ts/,
        /settings-row-surface\.layout\.spec\.ts/,
        // wallet-workspace: the card stack's ISO geometry, its no-overshoot
        // travel and the zero-shift open are felt on an iPhone first; the
        // fixture builds its own document.
        /wallet-workspace\.layout\.spec\.ts/,
        /wallet-scroll-reveal\.layout\.spec\.ts/,
        /wallet-card-scan\.layout\.spec\.ts/,
        /consent-center-row\.layout\.spec\.ts/,
        /shared-with-you-card\.layout\.spec\.ts/,
        // memory-save-card: the explicit-save receipt's pixel-grid contract
        // (insets, tile grid, aligned tabular counts) in the shipped engine.
        /memory-save-card\.layout\.spec\.ts/,
        /location-memory\.layout\.spec\.ts/,
        // reserved-offer-card: the receipt's "Add as Home in Location" rows and
        // Memory's read-only "Open in" row, tapped on an iPhone first.
        /reserved-offer-card\.layout\.spec\.ts/,
        // mail-kyc-connect: where an identity fact's "Open in Mail" lands
        // before Gmail is connected, tapped on an iPhone first; own document.
        /mail-kyc-connect\.layout\.spec\.ts/,
        // secrets-card: the secure Secrets card (reveal, copy, offers) is met
        // on an iPhone first; its 4/8 pt grid is asserted in the shipped engine.
        /secrets-card\.layout\.spec\.ts/,
        // style-settings: the owner's writing-style rows, 44 px controls and the
        // 12 px phone step are tapped on an iPhone first; own document.
        /style-settings\.layout\.spec\.ts/,
        /text-attachment-viewer\.layout\.spec\.ts/,
        /circle-chat\.layout\.spec\.ts/,
        /one-location-live-share\.layout\.spec\.ts/,
        /profile-sign-out\.spec\.ts/,
        /ai-selection\.layout\.spec\.ts/,
        /setup-hub\.layout\.spec\.ts/,
        /phone-entry\.layout\.spec\.ts/,
        /circle-discovery\.layout\.spec\.ts/,
        /guest-preview\.layout\.spec\.ts/,
        /document-share-review\.layout\.spec\.ts/,
        /drive-sharing-card\.layout\.spec\.ts/,
        // one-voice-mail-open: a flex row with an Open control and an
        // expand-in-place body, which people meet on an iPhone. A Chromium
        // pass says nothing about whether the 44px control and the wrapped
        // subject hold in the engine the app ships in.
        /one-voice-mail-open\.layout\.spec\.ts/,
        /mail-overview\.layout\.spec\.ts/,
        // receipt-sync-hero: the receipt hero and compact table are shipped
        // inside the iOS WKWebView and the fixture is self-contained.
        /receipt-sync-hero\.layout\.spec\.ts/,
        /receipt-pagination\.layout\.spec\.ts/,
        /connections-drawer\.layout\.spec\.ts/,
        /profile-legal-connectors\.layout\.spec\.ts/,
        /legal-pages\.spec\.ts/,
        /connect-living-circles\.layout\.spec\.ts/,
        // boot-surface: the one cold-start surface continues the iOS splash
        // inside the WKWebView, so its centring, zero-shift chain and splash
        // ink parity are measured in the engine the app ships in; own document.
        /boot-surface\.layout\.spec\.ts/,
        /(intro-viewport\.layout|country-picker\.layout|account-session-recovery|agent-surface-model-authority\.layout|one-voice-panel\.layout|connect-sticky-header\.layout|circle-join-responsive-contract|circle-member-row\.layout|connect-circle-cta\.layout|location-cta-layout|google-contact-sync\.layout|location-switch\.layout|active-share-actions\.layout|one-location-requests-sent-row\.layout|one-location-duration-ladder\.layout|gemini-endpoint-fields\.layout|feed-needs-you-row\.layout|one-location-people-rows\.layout|one-location-tab-strip\.layout|one-location-ready-panel\.layout|one-location-map-consent-panel\.layout|one-location-flow-action-footer\.layout|app-shell-top-clearance\.layout|app-shell-bottom-clearance\.layout|save-location-sheet\.layout|one-location-check-in-panel\.layout|contact-invitation-sheet\.layout)\.spec\.ts/,
      ],
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
  webServer:
    process.env.CI && process.env.PLAYWRIGHT_START_SERVER !== "1"
      ? undefined
      : {
          command: `npm run dev -- --port ${basePort}`,
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
});
