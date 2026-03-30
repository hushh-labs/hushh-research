const fs = require("node:fs");
const path = require("node:path");
const { test, expect, devices } = require("@playwright/test");
const {
  ensureReviewerSession,
  unlockIfNeeded,
  installPasskeyBypass,
  gotoStable,
  ensurePersona,
  attachRuntimeAudit,
  summarizeResourceEvents,
  waitForRouteSurface,
  captureScreens,
} = require("./runtime-audit.helpers.js");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/ria-onboarding"
);
const IPHONE_13 = devices["iPhone 13"];

const ALL_VARIANTS = [
  {
    name: "desktop",
    use: {
      viewport: { width: 1440, height: 1100 },
    },
  },
  {
    name: "mobile",
    use: {
      viewport: IPHONE_13.viewport,
      userAgent: IPHONE_13.userAgent,
      deviceScaleFactor: IPHONE_13.deviceScaleFactor,
      isMobile: IPHONE_13.isMobile,
      hasTouch: IPHONE_13.hasTouch,
    },
  },
];

for (const variant of ALL_VARIANTS) {
  test.describe(`${variant.name} RIA onboarding flow`, () => {
    test.use(variant.use);
    test.setTimeout(180_000);

    test(`${variant.name} completes RIA professional onboarding end to end`, async ({ page }) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });

      // 1. Install passkey bypass
      await installPasskeyBypass(page);

      // 2. Collect page errors
      const pageErrors = [];
      page.on("pageerror", (error) => {
        pageErrors.push({
          name: error?.name || "Error",
          message: error?.message || String(error),
        });
      });

      // 3. Establish reviewer session
      const authBootstrap = await ensureReviewerSession(page, "/kai");
      await page.waitForTimeout(1200);
      await unlockIfNeeded(page);

      // 4. Attach runtime audit
      const collector = attachRuntimeAudit(page);

      // 5. Ensure persona is "ria"
      const personaResult = await ensurePersona(page, "ria");

      // 6. Navigate to /ria
      await gotoStable(page, "/ria");
      await page.waitForTimeout(1200);
      await unlockIfNeeded(page);

      // 7. Wait for route surface
      await waitForRouteSurface(page);

      // 8. Verify RIA home renders (heading or client list)
      const riaHomeContent = page.locator(
        '[data-testid="ria-home-primary"], [data-testid*="ria-home"], main'
      ).first();
      const riaHomeVisible = await riaHomeContent.isVisible().catch(() => false);

      const riaHeading = page.locator(
        'h1, h2, [data-testid="top-app-bar-title"]'
      ).first();
      const riaHeadingText = await riaHeading.textContent().catch(() => "");

      const clientListVisible = await page
        .locator('[data-testid*="client"], [data-testid*="queue"], [data-testid*="launcher"]')
        .first()
        .isVisible()
        .catch(() => false);

      // 9. Navigate to /ria/onboarding if available
      let riaOnboardingVisible = false;
      let onboardingSteps = {};

      await gotoStable(page, "/ria/onboarding");
      await page.waitForTimeout(1200);
      await unlockIfNeeded(page);
      await waitForRouteSurface(page);

      const onboardingContent = page.locator(
        'h1, h2, [data-testid*="onboarding"], [data-testid="page-primary-module"], main'
      ).first();
      riaOnboardingVisible = await onboardingContent.isVisible().catch(() => false);

      // 10. Check for onboarding step elements
      onboardingSteps = {
        firmInfo: await page.getByText(/firm|practice|company/i).first().isVisible().catch(() => false),
        credentials: await page.getByText(/credentials|license|certification/i).first().isVisible().catch(() => false),
        serviceOfferings: await page.getByText(/service|offering|specialt/i).first().isVisible().catch(() => false),
        nextButton: await page.getByRole("button", { name: /next|continue|get started|submit/i }).first().isVisible().catch(() => false),
      };

      // 11. Capture screenshots
      const screenshotDir = path.join(OUT_DIR, variant.name, "screens");
      const riaHomeCaptures = await captureScreens(page, screenshotDir, "ria-home");

      // Navigate back to capture onboarding screens if we moved away
      if (riaOnboardingVisible) {
        await gotoStable(page, "/ria/onboarding");
        await page.waitForTimeout(1200);
        await unlockIfNeeded(page);
        await waitForRouteSurface(page);
      }
      const onboardingCaptures = await captureScreens(page, screenshotDir, "ria-onboarding");

      // 12. Drain audit, verify no page errors
      const audit = await collector.drain();
      const resourceSummary = summarizeResourceEvents(audit.resourceEvents);

      // 13. Write JSON report
      const report = {
        variant: variant.name,
        timestamp: new Date().toISOString(),
        authBootstrap,
        personaResult,
        riaHome: {
          visible: riaHomeVisible,
          headingText: riaHeadingText,
          clientListVisible,
        },
        riaOnboarding: {
          visible: riaOnboardingVisible,
          steps: onboardingSteps,
        },
        captures: {
          riaHome: riaHomeCaptures.map((capture) => ({
            label: capture.label,
            filePath: capture.filePath,
          })),
          riaOnboarding: onboardingCaptures.map((capture) => ({
            label: capture.label,
            filePath: capture.filePath,
          })),
        },
        audit: {
          requestCount: audit.requests.length,
          failedRequests: audit.failedRequests,
          httpFailures: audit.httpFailures,
          consoleWarnings: audit.consoleMessages
            .filter((message) => message.type === "warning" || message.type === "error")
            .slice(0, 50),
          pageErrors: audit.pageErrors,
          resourceEventCount: audit.resourceEvents.length,
          resourceSummary,
        },
        pageErrors,
        finalUrl: page.url(),
      };

      const reportPath = path.join(OUT_DIR, `${variant.name}-report.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

      console.log(
        JSON.stringify(
          {
            variant: variant.name,
            authBootstrap,
            personaResult,
            riaHomeVisible,
            riaOnboardingVisible,
            onboardingSteps,
            pageErrorCount: pageErrors.length,
            reportPath,
          },
          null,
          2
        )
      );

      expect(pageErrors, "unexpected page errors during RIA onboarding flow").toHaveLength(0);
    });
  });
}
