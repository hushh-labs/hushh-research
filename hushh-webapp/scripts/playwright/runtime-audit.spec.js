const fs = require("node:fs");
const path = require("node:path");
const { test, devices } = require("@playwright/test");
const {
  BASE_URL,
  attachRuntimeAudit,
  buildAuditScenarios,
  buildRuntimeFingerprint,
  captureScreens,
  collectShellMetrics,
  ensurePersona,
  ensureReviewerSession,
  gotoStable,
  installPasskeyBypass,
  normalizeTokenValue,
  resolveScenarioPath,
  summarizeRequests,
  summarizeResourceEvents,
  unlockIfNeeded,
  waitForRouteSurface,
} = require("./runtime-audit.helpers");

const OUT_DIR = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/runtime-audit"
);

const IPHONE_13 = devices["iPhone 13"];
const VARIANT_ALLOWLIST = new Set(
  String(process.env.RUNTIME_AUDIT_VARIANTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const ROUTE_FILTER = String(process.env.RUNTIME_AUDIT_ROUTE_FILTER || "").trim();
const ROUTE_FILTER_REGEX = ROUTE_FILTER ? new RegExp(ROUTE_FILTER, "i") : null;
const SKIP_SCREENS = process.env.RUNTIME_AUDIT_SKIP_SCREENS === "1";
const SOFT_FAIL = process.env.RUNTIME_AUDIT_SOFT_FAIL === "1";

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
const VARIANTS = ALL_VARIANTS.filter(
  (variant) => VARIANT_ALLOWLIST.size === 0 || VARIANT_ALLOWLIST.has(variant.name)
);

const HOT_ROUTE_SCENARIOS = [
  { route: "/kai", slug: "kai-market", persona: "investor", mode: "standard" },
  { route: "/kai/portfolio", slug: "kai-portfolio", persona: "investor", mode: "standard" },
  { route: "/kai/analysis", slug: "kai-analysis", persona: "investor", mode: "standard" },
];

function parsePx(value) {
  const parsed = Number.parseFloat(String(value || "").replace("px", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function evaluateShellBreaches(scenario, metrics) {
  const breaches = [];
  const rootTopStart = normalizeTokenValue(metrics.tokens?.root?.["--page-top-start"]);
  const shellTopStart = normalizeTokenValue(metrics.tokens?.shellRoot?.["--page-top-start"]);
  const rootContentOffset = normalizeTokenValue(metrics.tokens?.root?.["--app-top-content-offset"]);
  const shellContentOffset = normalizeTokenValue(
    metrics.tokens?.shellRoot?.["--app-top-content-offset"]
  );

  if (!metrics.rowBox || !metrics.titleBox || !metrics.actionsBox) {
    breaches.push("top-app-bar geometry missing");
    return breaches;
  }

  if (metrics.scrollWidth > metrics.innerWidth + 1) {
    breaches.push(`horizontal overflow detected (${metrics.scrollWidth} > ${metrics.innerWidth})`);
  }

  const alignmentDelta = Math.abs((metrics.titleBox?.y || 0) - (metrics.actionsBox?.y || 0));
  if (alignmentDelta > 2) {
    breaches.push(`top-app-bar title/actions misaligned by ${alignmentDelta.toFixed(2)}px`);
  }

  if (scenario.mode === "standard") {
    if (rootTopStart !== "75px") {
      breaches.push(`root --page-top-start expected 75px, got "${rootTopStart || "unset"}"`);
    }
    if (shellTopStart !== "75px") {
      breaches.push(`shell --page-top-start expected 75px, got "${shellTopStart || "unset"}"`);
    }
    if (!rootContentOffset || !shellContentOffset) {
      breaches.push("standard route missing --app-top-content-offset");
    }
    if (metrics.spacerHeight <= 0) {
      breaches.push("standard route top spacer height is zero");
    }
  }

  if (scenario.mode === "flow") {
    if (rootTopStart !== "0px") {
      breaches.push(`flow route root --page-top-start expected 0px, got "${rootTopStart || "unset"}"`);
    }
  }

  if (
    scenario.mode === "standard" &&
    metrics.firstMeaningfulTop < (metrics.rowBox?.y || 0) + (metrics.rowBox?.height || 0) + 8
  ) {
    breaches.push(
      `first meaningful content overlaps top shell (${metrics.firstMeaningfulTop.toFixed(2)} < ${(metrics.rowBox.y + metrics.rowBox.height + 8).toFixed(2)})`
    );
  }

  const expectedSpacer = parsePx(rootContentOffset);
  if (expectedSpacer > 0 && scenario.mode === "standard") {
    const delta = Math.abs(metrics.spacerHeight - expectedSpacer);
    if (delta > 2) {
      breaches.push(`top spacer height drift (${metrics.spacerHeight.toFixed(2)}px vs ${expectedSpacer.toFixed(2)}px)`);
    }
  }

  return breaches;
}

function evaluatePerformanceBreaches(durationMs, variantName, scenario) {
  if (scenario.mode === "redirect") {
    return [];
  }
  const thresholdMs = variantName === "desktop" ? 1500 : 2000;
  if (durationMs <= thresholdMs) {
    return [];
  }
  return [`route stabilization ${durationMs}ms exceeded ${thresholdMs}ms target`];
}

async function auditScenario(page, variantName, scenario, phase = "cold") {
  const resolvedPath = await resolveScenarioPath(page, scenario);
  if (!resolvedPath) {
    return {
      ...scenario,
      phase,
      skipped: true,
      reason: "dynamic route could not be discovered",
    };
  }

  await ensurePersona(page, scenario.persona);
  const collector = attachRuntimeAudit(page);
  const startedAt = Date.now();

  await gotoStable(page, resolvedPath);
  await page.waitForTimeout(1200);
  await waitForRouteSurface(page);
  await page.waitForTimeout(600);

  const audit = await collector.drain();
  const finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
  if (
    scenario.mode === "flow" &&
    finalPath !== resolvedPath
  ) {
    return {
      ...scenario,
      phase,
      requestedPath: resolvedPath,
      finalPath,
      skipped: true,
      reason: "flow route redirected to active destination",
    };
  }
  const shellMetrics = await collectShellMetrics(page);
  const navigationTiming = await readNavigationTiming(page);
  const screenshotDir = path.join(OUT_DIR, variantName, "screens");
  const captures = SKIP_SCREENS
    ? []
    : await captureScreens(page, screenshotDir, `${scenario.slug}-${phase}`);
  const durationMs = Date.now() - startedAt;
  const requestGroups = summarizeRequests(audit.requests);
  const resourceGroups = summarizeResourceEvents(audit.resourceEvents);

  return {
    ...scenario,
    phase,
    requestedPath: resolvedPath,
    finalPath,
    durationMs,
    navigationTiming,
    captures,
    shellMetrics,
    requestAudit: {
      total: audit.requests.length,
      groups: requestGroups,
      duplicates: requestGroups.filter((group) => group.count > 1),
    },
    failedRequests: audit.failedRequests,
    httpFailures: audit.httpFailures,
    consoleMessages: audit.consoleMessages,
    pageErrors: audit.pageErrors,
    resourceAudit: {
      total: audit.resourceEvents.length,
      groups: resourceGroups,
      duplicateNetworkFetches: resourceGroups.filter(
        (group) => Number(group.stages?.network_fetch || 0) > 1
      ),
    },
    breaches: [
      ...evaluateShellBreaches(scenario, shellMetrics),
      ...evaluatePerformanceBreaches(durationMs, variantName, scenario),
    ],
  };
}

async function auditHotRevisit(page, variantName, scenario, phase) {
  const resolvedPath = await resolveScenarioPath(page, scenario);
  if (!resolvedPath) {
    return {
      ...scenario,
      phase,
      skipped: true,
      reason: "dynamic route could not be discovered",
    };
  }

  await ensurePersona(page, scenario.persona);
  await gotoStable(page, resolvedPath);
  await page.waitForTimeout(1200);
  await waitForRouteSurface(page);
  await page.waitForTimeout(400);

  const collector = attachRuntimeAudit(page);
  const startedAt = Date.now();

  if (phase === "hard-reload") {
    await page.reload({ waitUntil: "domcontentloaded" });
  } else {
    await gotoStable(page, resolvedPath);
  }

  await page.waitForTimeout(1200);
  await waitForRouteSurface(page);
  await page.waitForTimeout(600);

  const audit = await collector.drain();
  const shellMetrics = await collectShellMetrics(page);
  const navigationTiming = await readNavigationTiming(page);
  const durationMs = Date.now() - startedAt;
  const screenshotDir = path.join(OUT_DIR, variantName, "screens");
  const captures = SKIP_SCREENS
    ? []
    : await captureScreens(page, screenshotDir, `${scenario.slug}-${phase}`);
  const requestGroups = summarizeRequests(audit.requests);
  const resourceGroups = summarizeResourceEvents(audit.resourceEvents);

  return {
    ...scenario,
    phase,
    requestedPath: resolvedPath,
    finalPath: new URL(page.url()).pathname + new URL(page.url()).search,
    durationMs,
    navigationTiming,
    captures,
    shellMetrics,
    requestAudit: {
      total: audit.requests.length,
      groups: requestGroups,
      duplicates: requestGroups.filter((group) => group.count > 1),
    },
    failedRequests: audit.failedRequests,
    httpFailures: audit.httpFailures,
    consoleMessages: audit.consoleMessages,
    pageErrors: audit.pageErrors,
    resourceAudit: {
      total: audit.resourceEvents.length,
      groups: resourceGroups,
      duplicateNetworkFetches: resourceGroups.filter(
        (group) => Number(group.stages?.network_fetch || 0) > 1
      ),
    },
    breaches: [
      ...evaluateShellBreaches(scenario, shellMetrics),
      ...evaluatePerformanceBreaches(durationMs, variantName, scenario),
      ...(phase === "warm"
        ? []
        : []),
    ],
  };
}

function buildSummaryMarkdown(report) {
  const coldRoutes = report.routes.filter((route) => !route.skipped && !route.error);
  const hotRoutes = report.hotRoutes.filter((route) => !route.skipped && !route.error);
  const average = (values) =>
    values.length > 0
      ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
      : null;
  const coldAverage = average(coldRoutes.map((route) => route.durationMs || 0));
  const hotAverage = average(hotRoutes.map((route) => route.durationMs || 0));
  const slowestColdRoutes = [...coldRoutes]
    .sort((left, right) => (right.durationMs || 0) - (left.durationMs || 0))
    .slice(0, 10);
  const lines = [
    `# Runtime Audit Summary (${report.variant})`,
    ``,
    `- Base URL: ${report.runtime.baseUrl}`,
    `- Auth bootstrap: ${report.authBootstrap.bootstrap}`,
    `- Vault bootstrap: ${report.vaultBootstrap.state}`,
    `- Routes audited: ${report.routes.length}`,
    `- Hot-route phases: ${report.hotRoutes.length}`,
    `- Runtime token mismatches: ${report.runtime.mismatches.length}`,
    `- Breach count: ${report.failures.length}`,
    `- Average cold stabilization: ${coldAverage === null ? "n/a" : `${coldAverage}ms`}`,
    `- Average hot-route stabilization: ${hotAverage === null ? "n/a" : `${hotAverage}ms`}`,
    ``,
    `## Runtime fingerprint`,
    `- Frontend: ${report.runtime.localProcesses.frontend?.process || "n/a"}`,
    `- Backend: ${report.runtime.localProcesses.backend?.process || "n/a"}`,
    `- Git SHA: ${report.runtime.git.sha || "n/a"}`,
    `- Git dirty: ${report.runtime.git.dirty ? "yes" : "no"}`,
    ``,
    `## Top breaches`,
  ];

  const topFailures = report.failures.slice(0, 20);
  if (topFailures.length === 0) {
    lines.push(`- None`);
  } else {
    for (const failure of topFailures) {
      lines.push(
        `- ${failure.scope}: ${failure.message}`
      );
    }
  }

  lines.push(``, `## Slowest cold routes`);
  if (slowestColdRoutes.length === 0) {
    lines.push(`- None`);
  } else {
    for (const route of slowestColdRoutes) {
      lines.push(
        `- ${route.finalPath || route.route}: ${route.durationMs}ms` +
          ` | requests=${route.requestAudit?.total || 0}` +
          ` | duplicate paths=${route.requestAudit?.duplicates?.length || 0}` +
          ` | duplicate resource fetches=${route.resourceAudit?.duplicateNetworkFetches?.length || 0}`
      );
    }
  }

  lines.push(``, `## Hot-route KPIs`);
  if (hotRoutes.length === 0) {
    lines.push(`- None`);
  } else {
    for (const route of hotRoutes) {
      lines.push(
        `- ${route.slug}:${route.phase}: ${route.durationMs}ms` +
          ` | requests=${route.requestAudit?.total || 0}` +
          ` | duplicate paths=${route.requestAudit?.duplicates?.length || 0}` +
          ` | duplicate resource fetches=${route.resourceAudit?.duplicateNetworkFetches?.length || 0}`
      );
    }
  }

  return lines.join("\n");
}

for (const variant of VARIANTS) {
  test.describe(`${variant.name} unified runtime audit`, () => {
    test.use(variant.use);

    test(`${variant.name} audits signed-in investor and RIA runtime performance end to end`, async ({
      page,
    }) => {
      test.setTimeout(1200000);
      fs.mkdirSync(OUT_DIR, { recursive: true });

      await installPasskeyBypass(page);
      const authBootstrap = await ensureReviewerSession(page, "/kai");
      const vaultBootstrap = await unlockIfNeeded(page);
      await waitForRouteSurface(page);
      const runtimeFingerprint = await buildRuntimeFingerprint(page);

      const report = {
        variant: variant.name,
        authBootstrap,
        vaultBootstrap,
        runtime: runtimeFingerprint,
        routes: [],
        hotRoutes: [],
        failures: [],
      };

      if (runtimeFingerprint.mismatches.length > 0) {
        for (const token of runtimeFingerprint.mismatches) {
          report.failures.push({
            scope: "runtime_fingerprint",
            message: `${token} source="${runtimeFingerprint.sourceTokens[token]}" served="${runtimeFingerprint.servedTokens[token]}"`,
          });
        }
      }

      const scenarios = buildAuditScenarios().filter((scenario) => {
        if (!ROUTE_FILTER_REGEX) return true;
        return ROUTE_FILTER_REGEX.test(scenario.route) || ROUTE_FILTER_REGEX.test(scenario.slug);
      });

      for (const scenario of scenarios) {
        try {
          const entry = await auditScenario(page, variant.name, scenario, "cold");
          report.routes.push(entry);
          for (const breach of entry.breaches || []) {
            report.failures.push({
              scope: `${entry.slug}:${entry.phase}`,
              message: breach,
            });
          }
          if (entry.pageErrors?.length) {
            report.failures.push({
              scope: `${entry.slug}:${entry.phase}`,
              message: `${entry.pageErrors.length} pageerror event(s) detected`,
            });
          }
        } catch (error) {
          report.routes.push({
            ...scenario,
            phase: "cold",
            error: error instanceof Error ? error.message : String(error),
          });
          report.failures.push({
            scope: `${scenario.slug}:cold`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const scenario of HOT_ROUTE_SCENARIOS) {
        for (const phase of ["warm", "hard-reload"]) {
          try {
            const entry = await auditHotRevisit(page, variant.name, scenario, phase);
            report.hotRoutes.push(entry);
            for (const breach of entry.breaches || []) {
              report.failures.push({
                scope: `${entry.slug}:${entry.phase}`,
                message: breach,
              });
            }
            if ((entry.requestAudit?.duplicates || []).length > 0) {
              report.failures.push({
                scope: `${entry.slug}:${entry.phase}`,
                message: `${entry.requestAudit.duplicates.length} duplicate API path group(s) detected`,
              });
            }
            if ((entry.resourceAudit?.duplicateNetworkFetches || []).length > 0) {
              report.failures.push({
                scope: `${entry.slug}:${entry.phase}`,
                message: `${entry.resourceAudit.duplicateNetworkFetches.length} duplicate resource network fetch group(s) detected`,
              });
            }
          } catch (error) {
            report.hotRoutes.push({
              ...scenario,
              phase,
              error: error instanceof Error ? error.message : String(error),
            });
            report.failures.push({
              scope: `${scenario.slug}:${phase}`,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const reportPath = path.join(OUT_DIR, `${variant.name}-report.json`);
      const summaryPath = path.join(OUT_DIR, `${variant.name}-summary.md`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      fs.writeFileSync(summaryPath, buildSummaryMarkdown(report));

      if (!SOFT_FAIL && report.failures.length > 0) {
        throw new Error(
          `${report.failures.length} runtime audit breach(es) detected. See ${reportPath}`
        );
      }
    });
  });
}
