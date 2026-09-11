// Read-only first-run-state reachability. This does not prove account creation,
// provider success, or database pool occupancy. No protected artifacts are saved.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export function isFirstRunState(state, expectedOwner) {
  const incompleteJourney = state?.onboardingJourneyVersion === 1
    && ["anonymous_auth", "phone_required", "setup_hub", "capability_setup", "external_connector"].includes(state.onboardingPhase);
  return Boolean(expectedOwner && state?.userId === expectedOwner
    && state.hasVault === false && state.vaultStatus === "placeholder"
    && state.setupCompleted !== true && state.onboardingPhase !== "root_completion"
    && (state.setupCompleted === false || incompleteJourney)
    && Array.isArray(state.setupCapabilityIds)
    && !state.setupCapabilityIds.some((id) => id === "cloud" || id === "connections")
    && !state.oneRuntimeSetupChoice);
}

export function trackApiConcurrency(page, origin, stage) {
  const inflight = new Set();
  let peakInflight = 0;
  let peakStage = "authentication";
  let failedRequests = 0;
  const isApi = (request) => {
    try {
      const url = new URL(request.url());
      return url.origin === new URL(origin).origin && url.pathname.startsWith("/api/");
    } catch { return false; }
  };
  page.on("request", (request) => {
    if (!isApi(request)) return;
    inflight.add(request);
    if (inflight.size > peakInflight) {
      peakInflight = inflight.size;
      peakStage = stage();
    }
  });
  page.on("requestfinished", (request) => inflight.delete(request));
  page.on("requestfailed", (request) => {
    if (inflight.delete(request)) failedRequests += 1;
  });
  return () => ({ peakInflight, peakStage, failedRequests, outstandingRequests: inflight.size });
}

export async function auditFirstRun({ reviewer, browser, origin, budgetMs = 60_000 }) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 600_000) {
    throw new Error("Invalid first-run time budget.");
  }
  const started = performance.now();
  const deadline = started + budgetMs;
  const remaining = () => {
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) throw new Error("deadline");
    return left;
  };
  let cancelled = false;
  const assertActive = () => {
    if (cancelled) throw new Error("cancelled");
    remaining();
  };
  let stage = "authentication";
  let session;
  let timer;
  const metrics = [];
  const report = {
    passed: false, hubRendered: false, reached: false, actual_tile_click: false,
    first_run_state: false, account_creation_proven: false,
    database_pool_measured: false, telemetry_delivery_proven: false, browserJourneyBudgetMs: budgetMs,
  };
  try {
    const run = async () => {
      const opened = await reviewer.openSession(browser, "/one/setup", {
        requireVaultUnlocked: false,
        onPageCreated(page) { metrics.push(trackApiConcurrency(page, origin, () => stage)); },
      });
      if (cancelled) {
        await opened.context.close().catch(() => undefined);
        throw new Error("cancelled");
      }
      session = opened;
      assertActive();
      const { page, capture, readOnlyGuard } = session;
      stage = "owner_state";
      const bearer = capture.firebaseBearer();
      if (!bearer) throw new Error("missing authentication");
      const response = await page.request.post(`${origin}/api/vault/bootstrap-state`, {
        headers: { Authorization: `Bearer ${bearer}` }, data: {}, timeout: remaining(),
      });
      try {
        if (response.status() !== 200) throw new Error("state unavailable");
        const state = await response.json();
        assertActive();
        report.first_run_state = isFirstRunState(state, reviewer.reviewerUid);
      } finally { await response.dispose(); }
      assertActive();
      if (!report.first_run_state) throw new Error("fixture is not in first-run state");
      stage = "setup_hub";
      const tile = page.locator('[data-voice-control-id="one_setup_tile_cloud"]');
      await tile.waitFor({ state: "visible", timeout: remaining() });
      assertActive();
      report.hubRendered = true;
      await tile.click({ timeout: remaining() });
      assertActive();
      report.actual_tile_click = true;
      stage = "cloud_choice";
      await page.locator('[data-testid="cloud-tier-choice"]')
        .waitFor({ state: "visible", timeout: remaining() });
      assertActive();
      await page.waitForFunction(() => window.location.pathname === "/one/setup/cloud", undefined, { timeout: remaining() });
      await reviewer.assertVaultContinuity(page, "first-run cloud choice");
      assertActive();
      readOnlyGuard.assertNoBlockedMutation();
      capture.assertNoCriticalApiFailures("first-run");
      report.reached = true;
    };
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          reject(new Error("deadline"));
          void browser.close().catch(() => undefined);
        }, remaining());
      }),
    ]);
    report.passed = true;
  } catch {
    cancelled = true;
    report.failureStage = stage; // Finite stage only: never exception text or page content.
  } finally {
    cancelled = true;
    clearTimeout(timer);
    report.elapsedMs = Math.ceil(performance.now() - started);
    report.browserApiConcurrency = metrics.map((read) => read());
    await session?.context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  return structuredClone(report);
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const origin = process.env.ONE_ORIGIN || process.env.REVIEWER_APP_ORIGIN || "http://localhost:3000";
  const { prepareReviewerRehearsal } = await import("../../../.codex/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs");
  const { createReviewerSessionHarness } = await import("../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs");
  const preflight = await prepareReviewerRehearsal({ repoRoot, appOrigin: origin });
  if (preflight.mutationPolicy !== "read_only") throw new Error("Read-only rehearsal required.");
  const budgetMs = Number(process.env.FIRST_RUN_BUDGET_MS || 60_000);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 600_000) throw new Error("Invalid first-run time budget.");
  const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin: origin, timeoutMs: budgetMs });
  const browser = await reviewer.chromium.launch({ headless: true });
  const report = await auditFirstRun({ reviewer, browser, origin, budgetMs });
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.log(JSON.stringify({ passed: false, failureStage: "preflight" }));
    process.exitCode = 1;
  });
}
