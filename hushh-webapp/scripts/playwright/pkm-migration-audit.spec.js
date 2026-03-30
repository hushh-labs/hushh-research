const fs = require("node:fs");
const path = require("node:path");
const { test, expect, devices } = require("@playwright/test");
const {
  ensureReviewerSession,
  unlockIfNeeded,
  installPasskeyBypass,
  gotoStable,
  attachRuntimeAudit,
  waitForRouteSurface,
  captureScreens,
} = require("./runtime-audit.helpers.js");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/pkm-migration-audit"
);
const IPHONE_13 = devices["iPhone 13"];

const PKM_ROUTES = [
  "/profile/pkm-agent-lab",
  "/profile/pkm",
];

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
  test.describe(`${variant.name} PKM migration audit`, () => {
    test.use(variant.use);
    test.setTimeout(120_000);

    test(`${variant.name} monitors PKM migration behavior after vault unlock`, async ({ page }) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });

      // 1. Install passkey bypass
      await installPasskeyBypass(page);

      // 2. Collect ALL console messages (including [PersonalKnowledgeModelService] markers)
      const allConsoleLogs = [];
      const pkmMigrationMarkers = [];
      page.on("console", (message) => {
        const text = message.text();
        allConsoleLogs.push({
          type: message.type(),
          text,
          location: message.location(),
        });
        if (text.includes("[PersonalKnowledgeModelService]")) {
          pkmMigrationMarkers.push({
            type: message.type(),
            text,
            location: message.location(),
          });
        }
      });

      const pageErrors = [];
      page.on("pageerror", (error) => {
        pageErrors.push({
          name: error?.name || "Error",
          message: error?.message || String(error),
        });
      });

      // 3. Establish reviewer session
      const authBootstrap = await ensureReviewerSession(page, "/kai");

      // 4. Unlock vault
      await page.waitForTimeout(1200);
      const vaultBootstrap = await unlockIfNeeded(page);
      await waitForRouteSurface(page);

      // 5. Navigate to PKM route (try /profile/pkm-agent-lab first, fall back to /profile/pkm)
      let resolvedPkmRoute = null;
      let pkmPageVisible = false;

      for (const pkmRoute of PKM_ROUTES) {
        await gotoStable(page, pkmRoute);
        await page.waitForTimeout(1500);
        await unlockIfNeeded(page);
        await waitForRouteSurface(page);

        const mainContent = page.locator("main").first();
        const mainVisible = await mainContent.isVisible().catch(() => false);
        if (mainVisible) {
          resolvedPkmRoute = pkmRoute;
          pkmPageVisible = true;
          break;
        }
      }

      // 6. Wait for route surface
      if (pkmPageVisible) {
        await waitForRouteSurface(page);
        // Allow additional time for migration logs to appear
        await page.waitForTimeout(3000);
      }

      // 7. Check console logs for migration markers: [PersonalKnowledgeModelService]
      const migrationStarted = pkmMigrationMarkers.some((marker) =>
        /migrat|start|init|begin|upgrade/i.test(marker.text)
      );
      const migrationCompleted = pkmMigrationMarkers.some((marker) =>
        /complete|finish|done|success|ready/i.test(marker.text)
      );
      const migrationErrors = pkmMigrationMarkers.filter((marker) =>
        /error|fail|abort/i.test(marker.text)
      );

      // 8. Verify PKM page renders (heading, domain controls, etc.)
      const pkmHeading = page.locator(
        'h1, h2, [data-testid*="pkm"], [data-testid="page-primary-module"]'
      ).first();
      const pkmHeadingVisible = await pkmHeading.isVisible().catch(() => false);
      const pkmHeadingText = await pkmHeading.textContent().catch(() => "");

      const domainControls = {
        toolTab: await page.getByRole("button", { name: /^tool$/i }).isVisible().catch(() => false),
        domainSelector: await page.locator('[data-testid*="domain"], select, [role="combobox"]').first().isVisible().catch(() => false),
        previewButton: await page.getByRole("button", { name: /preview/i }).first().isVisible().catch(() => false),
        textarea: await page.locator("textarea").first().isVisible().catch(() => false),
      };

      // Capture screenshots
      const screenshotDir = path.join(OUT_DIR, variant.name, "screens");
      const captures = await captureScreens(
        page,
        screenshotDir,
        `pkm-migration-${resolvedPkmRoute ? resolvedPkmRoute.replace(/\//g, "-").replace(/^-/, "") : "none"}`
      );

      // 9. Write migration audit report to OUT_DIR
      const report = {
        variant: variant.name,
        timestamp: new Date().toISOString(),
        authBootstrap,
        vaultBootstrap,
        resolvedPkmRoute,
        pkmPageVisible,
        pkmHeading: {
          visible: pkmHeadingVisible,
          text: pkmHeadingText,
        },
        domainControls,
        migration: {
          totalMarkers: pkmMigrationMarkers.length,
          markers: pkmMigrationMarkers,
          started: migrationStarted,
          completed: migrationCompleted,
          errors: migrationErrors,
        },
        consoleSummary: {
          totalMessages: allConsoleLogs.length,
          errorCount: allConsoleLogs.filter((log) => log.type === "error").length,
          warningCount: allConsoleLogs.filter((log) => log.type === "warning").length,
          pkmRelated: allConsoleLogs.filter((log) =>
            /pkm|personal.?knowledge/i.test(log.text)
          ),
        },
        captures: captures.map((capture) => ({
          label: capture.label,
          filePath: capture.filePath,
        })),
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
            vaultBootstrap,
            resolvedPkmRoute,
            pkmPageVisible,
            migrationMarkerCount: pkmMigrationMarkers.length,
            migrationStarted,
            migrationCompleted,
            migrationErrorCount: migrationErrors.length,
            pageErrorCount: pageErrors.length,
            reportPath,
          },
          null,
          2
        )
      );

      expect(migrationErrors, "PKM migration produced error markers").toHaveLength(0);
    });
  });
}
