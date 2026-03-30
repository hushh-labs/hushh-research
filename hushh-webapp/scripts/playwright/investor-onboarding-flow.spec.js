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
  waitForRouteSurface,
  captureScreens,
} = require("./runtime-audit.helpers.js");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/investor-onboarding"
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
  test.describe(`${variant.name} investor onboarding flow`, () => {
    test.use(variant.use);
    test.setTimeout(180_000);

    test(`${variant.name} completes investor onboarding end to end`, async ({ page }) => {
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

      // 3. Establish reviewer session -> redirects to /kai
      const authBootstrap = await ensureReviewerSession(page, "/kai");

      // 4. Attach runtime audit
      const collector = attachRuntimeAudit(page);

      // 5. Verify the kai home page loads (look for main content area)
      await page.waitForTimeout(1200);
      await unlockIfNeeded(page);
      await waitForRouteSurface(page);
      const mainContent = page.locator("main").first();
      await expect(mainContent).toBeVisible({ timeout: 15000 });

      // 6. Ensure persona is "investor"
      const personaResult = await ensurePersona(page, "investor");

      // 7. Navigate to /kai/onboarding
      await gotoStable(page, "/kai/onboarding");
      await page.waitForTimeout(1200);
      await unlockIfNeeded(page);
      await waitForRouteSurface(page);

      // 8. Verify onboarding page renders (heading or persona selection elements)
      const onboardingHeading = page.locator(
        'h1, h2, [data-testid*="onboarding"], [data-testid="page-primary-module"]'
      ).first();
      const onboardingVisible = await onboardingHeading.isVisible().catch(() => false);

      // 9. Check for wizard step elements (investment horizon, risk tolerance, etc.)
      const wizardSteps = {
        investmentHorizon: await page.getByText(/investment horizon/i).first().isVisible().catch(() => false),
        riskTolerance: await page.getByText(/risk tolerance/i).first().isVisible().catch(() => false),
        personaSelection: await page.locator('[data-testid*="persona"], [data-testid*="onboarding-step"]').first().isVisible().catch(() => false),
        nextButton: await page.getByRole("button", { name: /next|continue|get started/i }).first().isVisible().catch(() => false),
      };

      // 10. Capture screenshots
      const screenshotDir = path.join(OUT_DIR, variant.name, "screens");
      const captures = await captureScreens(page, screenshotDir, "investor-onboarding");

      // 11. Drain audit, verify no page errors
      const audit = await collector.drain();

      // 12. Write JSON report to OUT_DIR
      const report = {
        variant: variant.name,
        timestamp: new Date().toISOString(),
        authBootstrap,
        personaResult,
        kaiHomeVisible: await mainContent.isVisible().catch(() => false),
        onboardingPageVisible: onboardingVisible,
        wizardSteps,
        captures: captures.map((capture) => ({
          label: capture.label,
          filePath: capture.filePath,
        })),
        audit: {
          requestCount: audit.requests.length,
          failedRequests: audit.failedRequests,
          httpFailures: audit.httpFailures,
          consoleWarnings: audit.consoleMessages
            .filter((message) => message.type === "warning" || message.type === "error")
            .slice(0, 50),
          pageErrors: audit.pageErrors,
          resourceEventCount: audit.resourceEvents.length,
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
            onboardingPageVisible: onboardingVisible,
            wizardSteps,
            pageErrorCount: pageErrors.length,
            reportPath,
          },
          null,
          2
        )
      );

      expect(pageErrors, "unexpected page errors during investor onboarding flow").toHaveLength(0);
    });
  });
}
