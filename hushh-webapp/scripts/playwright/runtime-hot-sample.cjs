const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");
const {
  BASE_URL,
  attachRuntimeAudit,
  buildRuntimeFingerprint,
  ensurePersona,
  ensureReviewerSession,
  gotoStable,
  installPasskeyBypass,
  resolveScenarioPath,
  summarizeRequests,
  summarizeResourceEvents,
  unlockIfNeeded,
  waitForRouteSurface,
} = require("./runtime-audit.helpers");

const MODE_LABEL = String(process.env.MODE_LABEL || "devlocal").trim() || "devlocal";
const OUT_DIR = path.resolve("/tmp/hushh-audit/runtime-hot");
const REPORT_PATH = path.join(OUT_DIR, `${MODE_LABEL}-report.json`);
const SUMMARY_PATH = path.join(OUT_DIR, `${MODE_LABEL}-summary.md`);

const ROUTES = [
  { route: "/kai", slug: "kai-market", persona: "investor" },
  { route: "/kai/portfolio", slug: "kai-portfolio", persona: "investor" },
  { route: "/kai/analysis", slug: "kai-analysis", persona: "investor" },
  { route: "/consents", slug: "consents-investor", persona: "investor" },
  { route: "/profile", slug: "profile-investor", persona: "investor" },
  { route: "/marketplace", slug: "marketplace-investor", persona: "investor" },
  { route: "/ria", slug: "ria-home", persona: "ria" },
  { route: "/ria/clients", slug: "ria-clients", persona: "ria" },
  { route: "/consents?actor=ria&view=outgoing&tab=pending", slug: "ria-consents", persona: "ria" },
];

const HOT_ROUTES = [
  { route: "/kai", slug: "kai-market", persona: "investor" },
  { route: "/kai/portfolio", slug: "kai-portfolio", persona: "investor" },
  { route: "/kai/analysis", slug: "kai-analysis", persona: "investor" },
  { route: "/profile", slug: "profile-investor", persona: "investor" },
  { route: "/ria", slug: "ria-home", persona: "ria" },
  { route: "/ria/clients", slug: "ria-clients", persona: "ria" },
];
const ROUTE_TIMEOUT_MS = 45_000;

function average(values) {
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function formatMs(value) {
  return value == null ? "n/a" : `${value}ms`;
}

function collectStageCounts(resourceGroups) {
  return resourceGroups.reduce((acc, group) => {
    for (const [stage, count] of Object.entries(group.stages || {})) {
      acc[stage] = (acc[stage] || 0) + Number(count || 0);
    }
    return acc;
  }, {});
}

function inferCacheSource(stageCounts) {
  if ((stageCounts.memory_hit || 0) > 0 || (stageCounts.revision_match_hit || 0) > 0) {
    return "memory";
  }
  if ((stageCounts.device_hit || 0) > 0) {
    return "device";
  }
  if ((stageCounts.stale_hit || 0) > 0 || (stageCounts.cache_hit || 0) > 0) {
    return "stale";
  }
  if ((stageCounts.network_fetch || 0) > 0) {
    return "network";
  }
  return "unknown";
}

async function readNotificationTaskSnapshot(page) {
  const trigger = page.getByRole("button", { name: /notifications/i }).first();
  const triggerVisible = await trigger.isVisible().catch(() => false);
  if (!triggerVisible) {
    return {
      available: false,
      pkmTaskVisible: false,
      lines: [],
    };
  }

  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(250);
  const menu = page.locator('[role="menu"]').last();
  const menuVisible = await menu.isVisible().catch(() => false);
  if (!menuVisible) {
    return {
      available: true,
      pkmTaskVisible: false,
      lines: [],
    };
  }

  const rawText = await menu.innerText().catch(() => "");
  await page.keyboard.press("Escape").catch(() => undefined);
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 16);
  return {
    available: true,
    pkmTaskVisible: lines.some((line) => /personal knowledge model|\bpkm\b/i.test(line)),
    lines,
  };
}

async function measureRoute(page, scenario, phase = "cold") {
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

  if (phase === "hard-reload") {
    await gotoStable(page, resolvedPath);
    await page.waitForTimeout(800);
    await waitForRouteSurface(page);
    await page.reload({ waitUntil: "domcontentloaded" });
  } else {
    await gotoStable(page, resolvedPath);
  }

  await page.waitForTimeout(900);
  await unlockIfNeeded(page);
  await waitForRouteSurface(page);
  await page.waitForTimeout(350);
  const notificationSnapshot = await readNotificationTaskSnapshot(page);

  const audit = await collector.drain();
  const durationMs = Date.now() - startedAt;
  const requestGroups = summarizeRequests(audit.requests);
  const resourceGroups = summarizeResourceEvents(audit.resourceEvents);
  const stageCounts = collectStageCounts(resourceGroups);

  return {
    ...scenario,
    phase,
    requestedPath: resolvedPath,
    finalPath: new URL(page.url()).pathname + new URL(page.url()).search,
    durationMs,
    cacheSource: inferCacheSource(stageCounts),
    stageCounts,
    requestAudit: {
      total: audit.requests.length,
      duplicates: requestGroups.filter((group) => group.count > 1),
      groups: requestGroups,
    },
    resourceAudit: {
      duplicateNetworkFetches: resourceGroups.filter(
        (group) => Number(group.stages?.network_fetch || 0) > 1
      ),
      groups: resourceGroups,
    },
    consoleMessages: audit.consoleMessages,
    failedRequests: audit.failedRequests,
    httpFailures: audit.httpFailures,
    pageErrors: audit.pageErrors,
    notificationSnapshot,
  };
}

async function measureRouteWithTimeout(page, scenario, phase) {
  console.log(`[runtime-hot-sample] ${MODE_LABEL} ${phase} ${scenario.route}`);
  return await Promise.race([
    measureRoute(page, scenario, phase),
    new Promise((_, reject) =>
      setTimeout(() => {
        reject(new Error(`Timed out after ${ROUTE_TIMEOUT_MS}ms`));
      }, ROUTE_TIMEOUT_MS)
    ),
  ]);
}

function buildSummary(report) {
  const cold = report.routes.filter((entry) => !entry.skipped && !entry.error);
  const hot = report.hotRoutes.filter((entry) => !entry.skipped && !entry.error);
  const lines = [
    `# Runtime Hot Route Summary (${report.modeLabel})`,
    "",
    `- Base URL: ${report.baseUrl}`,
    `- Frontend: ${report.runtime.localProcesses?.frontend?.process || "n/a"}`,
    `- Backend: ${report.runtime.localProcesses?.backend?.process || "n/a"}`,
    `- Runtime token mismatches: ${report.runtime.mismatches?.length || 0}`,
    `- Cold-route average: ${formatMs(average(cold.map((entry) => entry.durationMs || 0)))}`,
    `- Hot-route average: ${formatMs(average(hot.map((entry) => entry.durationMs || 0)))}`,
    "",
    "## Cold routes",
    "| Route | Persona | Duration | Cache source | Requests | Dup paths | Dup resource fetches | Console msgs | HTTP failures |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const entry of cold) {
    lines.push(
      `| ${entry.finalPath || entry.route} | ${entry.persona} | ${entry.durationMs} | ${entry.cacheSource} | ${entry.requestAudit?.total || 0} | ${entry.requestAudit?.duplicates?.length || 0} | ${entry.resourceAudit?.duplicateNetworkFetches?.length || 0} | ${entry.consoleMessages?.length || 0} | ${entry.httpFailures?.length || 0} |`
    );
  }

  lines.push(
    "",
    "## Hot revisits",
    "| Route | Phase | Duration | Cache source | Requests | Dup paths | Dup resource fetches | Console msgs | HTTP failures |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const entry of hot) {
    lines.push(
      `| ${entry.finalPath || entry.route} | ${entry.phase} | ${entry.durationMs} | ${entry.cacheSource} | ${entry.requestAudit?.total || 0} | ${entry.requestAudit?.duplicates?.length || 0} | ${entry.resourceAudit?.duplicateNetworkFetches?.length || 0} | ${entry.consoleMessages?.length || 0} | ${entry.httpFailures?.length || 0} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();

  try {
    await installPasskeyBypass(page);
    const authBootstrap = await ensureReviewerSession(page, "/kai");
    const vaultBootstrap = await unlockIfNeeded(page);
    await waitForRouteSurface(page);
    const runtime = await buildRuntimeFingerprint(page);

    const report = {
      modeLabel: MODE_LABEL,
      baseUrl: BASE_URL,
      authBootstrap,
      vaultBootstrap,
      runtime,
      routes: [],
      hotRoutes: [],
    };

    for (const scenario of ROUTES) {
      try {
        report.routes.push(await measureRouteWithTimeout(page, scenario, "cold"));
      } catch (error) {
        report.routes.push({
          ...scenario,
          phase: "cold",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const scenario of HOT_ROUTES) {
      for (const phase of ["warm", "hard-reload"]) {
        try {
          report.hotRoutes.push(await measureRouteWithTimeout(page, scenario, phase));
        } catch (error) {
          report.hotRoutes.push({
            ...scenario,
            phase,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    fs.writeFileSync(SUMMARY_PATH, buildSummary(report));
    process.stdout.write(`${REPORT_PATH}\n${SUMMARY_PATH}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
