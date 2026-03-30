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
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/performance-budget"
);
const IPHONE_13 = devices["iPhone 13"];
const SOFT_FAIL = process.env.PERF_SOFT_FAIL === "1";

const PERFORMANCE_BUDGETS = [
  {
    route: "/kai",
    slug: "kai-home",
    persona: "investor",
    desktop: { cold: 1500, warm: 800 },
    mobile: { cold: 2000, warm: 1000 },
  },
  {
    route: "/kai/portfolio",
    slug: "kai-portfolio",
    persona: "investor",
    desktop: { cold: 1500, warm: 800 },
    mobile: { cold: 2000, warm: 1000 },
  },
  {
    route: "/consents",
    slug: "consents",
    persona: "investor",
    desktop: { cold: 1500, warm: 1000 },
    mobile: { cold: 2000, warm: 1200 },
  },
  {
    route: "/ria",
    slug: "ria-home",
    persona: "ria",
    desktop: { cold: 1500, warm: 800 },
    mobile: { cold: 2000, warm: 1000 },
  },
];

async function readNavigationTiming(page) {
  return await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (!navigation) {
      return null;
    }
    return {
      type: navigation.type,
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
      loadEventMs: Math.round(navigation.loadEventEnd),
      responseEndMs: Math.round(navigation.responseEnd),
      transferSize: navigation.transferSize,
      decodedBodySize: navigation.decodedBodySize,
    };
  });
}

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
  test.describe(`${variant.name} performance budget audit`, () => {
    test.use(variant.use);
    test.setTimeout(240_000);

    test(`${variant.name} validates route load times against performance budgets`, async ({ page }) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });

      // 1. Install passkey bypass
      await installPasskeyBypass(page);

      const pageErrors = [];
      page.on("pageerror", (error) => {
        pageErrors.push({
          name: error?.name || "Error",
          message: error?.message || String(error),
        });
      });

      // 2. Establish reviewer session + unlock vault
      const authBootstrap = await ensureReviewerSession(page, "/kai");
      await page.waitForTimeout(1200);
      const vaultBootstrap = await unlockIfNeeded(page);
      await waitForRouteSurface(page);

      const routeResults = [];
      const budgetBreaches = [];

      // 3. For each route
      for (const budget of PERFORMANCE_BUDGETS) {
        const budgetThresholds = budget[variant.name];

        // Switch persona if needed
        await ensurePersona(page, budget.persona);

        // --- Cold load ---
        const coldCollector = attachRuntimeAudit(page);
        const coldStartMs = Date.now();

        await gotoStable(page, budget.route);
        await page.waitForTimeout(1200);
        await unlockIfNeeded(page);
        await waitForRouteSurface(page);
        await page.waitForTimeout(600);

        const coldDurationMs = Date.now() - coldStartMs;
        const coldNavigationTiming = await readNavigationTiming(page);
        const coldAudit = await coldCollector.drain();
        const coldResourceSummary = summarizeResourceEvents(coldAudit.resourceEvents);

        // --- Navigate away for warm load ---
        await gotoStable(page, "/profile");
        await page.waitForTimeout(1000);

        // --- Warm load ---
        const warmCollector = attachRuntimeAudit(page);
        const warmStartMs = Date.now();

        await gotoStable(page, budget.route);
        await page.waitForTimeout(1200);
        await unlockIfNeeded(page);
        await waitForRouteSurface(page);
        await page.waitForTimeout(600);

        const warmDurationMs = Date.now() - warmStartMs;
        const warmNavigationTiming = await readNavigationTiming(page);
        const warmAudit = await warmCollector.drain();
        const warmResourceSummary = summarizeResourceEvents(warmAudit.resourceEvents);

        // Check cache hit rates on warm loads
        const warmCacheHits = warmAudit.resourceEvents.filter((event) =>
          ["cache_hit", "stale_hit", "device_hit", "revision_match_hit"].includes(event.stage)
        );
        const warmNetworkFetches = warmAudit.resourceEvents.filter((event) =>
          event.stage === "network_fetch"
        );
        const warmTotalSignals = warmCacheHits.length + warmNetworkFetches.length;
        const warmCacheHitRate = warmTotalSignals > 0
          ? warmCacheHits.length / warmTotalSignals
          : null;

        // Capture screenshots
        const screenshotDir = path.join(OUT_DIR, variant.name, "screens");
        const captures = await captureScreens(page, screenshotDir, budget.slug);

        // Evaluate breaches
        const routeBreaches = [];

        if (coldDurationMs > budgetThresholds.cold) {
          routeBreaches.push({
            scope: `${budget.slug}:cold`,
            message: `cold load ${coldDurationMs}ms exceeded ${budgetThresholds.cold}ms budget`,
          });
        }

        if (warmDurationMs > budgetThresholds.warm) {
          routeBreaches.push({
            scope: `${budget.slug}:warm`,
            message: `warm load ${warmDurationMs}ms exceeded ${budgetThresholds.warm}ms budget`,
          });
        }

        budgetBreaches.push(...routeBreaches);

        routeResults.push({
          route: budget.route,
          slug: budget.slug,
          persona: budget.persona,
          budgets: budgetThresholds,
          cold: {
            durationMs: coldDurationMs,
            navigationTiming: coldNavigationTiming,
            requestCount: coldAudit.requests.length,
            failedRequestCount: coldAudit.failedRequests.length,
            httpFailureCount: coldAudit.httpFailures.length,
            resourceEventCount: coldAudit.resourceEvents.length,
            resourceSummary: coldResourceSummary,
            pageErrorCount: coldAudit.pageErrors.length,
            passed: coldDurationMs <= budgetThresholds.cold,
          },
          warm: {
            durationMs: warmDurationMs,
            navigationTiming: warmNavigationTiming,
            requestCount: warmAudit.requests.length,
            failedRequestCount: warmAudit.failedRequests.length,
            httpFailureCount: warmAudit.httpFailures.length,
            resourceEventCount: warmAudit.resourceEvents.length,
            resourceSummary: warmResourceSummary,
            cacheHitCount: warmCacheHits.length,
            networkFetchCount: warmNetworkFetches.length,
            cacheHitRate: warmCacheHitRate,
            pageErrorCount: warmAudit.pageErrors.length,
            passed: warmDurationMs <= budgetThresholds.warm,
          },
          breaches: routeBreaches,
          captures: captures.map((capture) => ({
            label: capture.label,
            filePath: capture.filePath,
          })),
        });
      }

      // 4. Write performance report JSON
      const report = {
        variant: variant.name,
        timestamp: new Date().toISOString(),
        softFail: SOFT_FAIL,
        authBootstrap,
        vaultBootstrap,
        routes: routeResults,
        summary: {
          totalRoutes: routeResults.length,
          passedCold: routeResults.filter((result) => result.cold.passed).length,
          passedWarm: routeResults.filter((result) => result.warm.passed).length,
          breachCount: budgetBreaches.length,
          breaches: budgetBreaches,
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
            softFail: SOFT_FAIL,
            authBootstrap,
            vaultBootstrap,
            totalRoutes: routeResults.length,
            passedCold: report.summary.passedCold,
            passedWarm: report.summary.passedWarm,
            breachCount: budgetBreaches.length,
            breaches: budgetBreaches.slice(0, 10),
            reportPath,
          },
          null,
          2
        )
      );

      // 5. Assert against budgets (use SOFT_FAIL pattern)
      if (!SOFT_FAIL && budgetBreaches.length > 0) {
        const breachSummary = budgetBreaches
          .map((breach) => `  ${breach.scope}: ${breach.message}`)
          .join("\n");
        throw new Error(
          `${budgetBreaches.length} performance budget breach(es) detected:\n${breachSummary}\nSee ${reportPath}`
        );
      }
    });
  });
}
