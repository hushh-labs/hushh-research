#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

import { chromium } from "playwright";
import {
  defaultReviewerIdentityEnvFiles,
  parseEnvFile,
  resolveReviewerTestIdentity,
} from "./reviewer-test-identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(webDir, "..");
const defaultImportFile = path.join(os.homedir(), "Downloads", "Jan312026SchwabHu$$h.pdf");
const importFilePath = path.resolve(process.env.KAI_IMPORT_E2E_FILE || defaultImportFile);
const reportPath = path.resolve(
  process.env.KAI_IMPORT_E2E_REPORT ||
    path.join(repoRoot, "tmp", "kai-import-e2e-report.json")
);
const appOrigin = (
  process.env.HUSHH_APP_ORIGIN ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";
const REVIEWER_BOOTSTRAP_ROUTE = "/ria";
const NAVIGATION_TIMEOUT_MS = 120_000;
const IMPORT_TIMEOUT_MS = Number(process.env.KAI_IMPORT_E2E_TIMEOUT_MS || 10 * 60_000);
const TERMINAL_DATA_STATES = [
  "loaded",
  "empty-valid",
  "unavailable-valid",
  "redirect-valid",
  "error",
];
const IMPORT_BACKGROUND_KEYS = [
  "kai_portfolio_import_background_v1",
  "hushh_session:kai_portfolio_import_background_v1",
];
const UI_FILE_NAME = path.basename(importFilePath);

function seedProcessEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key] && value) {
      process.env[key] = value;
    }
  }
}

for (const envPath of [
  path.join(repoRoot, "consent-protocol", ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(webDir, ".env.local"),
  path.join(webDir, ".env.uat.local"),
]) {
  seedProcessEnv(parseEnvFile(envPath));
}

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot, webDir }),
});
const reviewerPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(
      target,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode || 0);
      }
    );
    request.on("error", reject);
    request.end();
  });
}

async function canReach(url) {
  try {
    const status = await httpStatus(url);
    return status >= 200 && status < 500;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canReach(url)) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startDevServerIfNeeded() {
  let child = null;
  return {
    async ensure() {
      const loginUrl = `${appOrigin}/login`;
      if (await canReach(loginUrl)) {
        return null;
      }

      const origin = new URL(appOrigin);
      const localPort =
        ["localhost", "127.0.0.1", "::1"].includes(origin.hostname)
          ? origin.port || (origin.protocol === "http:" ? "3000" : "")
          : "";
      const args = localPort
        ? ["run", "dev", "--", "--port", localPort]
        : ["run", "dev"];

      child = spawn("npm", args, {
        cwd: webDir,
        env: { ...process.env },
        stdio: "pipe",
      });

      child.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)));
      child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));

      await waitForHttp(loginUrl);
      return child;
    },
    async stop() {
      if (!child) return;
      child.kill("SIGTERM");
      await sleep(1500);
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    },
  };
}

function assertImportFile() {
  if (!fs.existsSync(importFilePath)) {
    throw new Error(`KAI_IMPORT_E2E_FILE does not exist: ${importFilePath}`);
  }
  const stat = fs.statSync(importFilePath);
  if (!stat.isFile()) {
    throw new Error(`KAI_IMPORT_E2E_FILE is not a file: ${importFilePath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`KAI_IMPORT_E2E_FILE is empty: ${importFilePath}`);
  }
  return stat;
}

async function installNativeTestBridge(page) {
  await page.addInitScript(
    ({ expectedUserId, vaultPassphrase }) => {
      window.__HUSHH_NATIVE_TEST__ = {
        ...(window.__HUSHH_NATIVE_TEST__ || {}),
        enabled: true,
        autoReviewerLogin: true,
        expectedUserId,
        vaultPassphrase,
      };
    },
    {
      expectedUserId: reviewerUid,
      vaultPassphrase: reviewerPassphrase,
    }
  );
}

async function captureDiagnostics(page) {
  return page.evaluate(() => ({
    url: window.location.href,
    readyState: document.readyState,
    beacons: Array.from(document.querySelectorAll("[data-native-test-beacon='true']")).map(
      (node) => ({
        routeId: node.getAttribute("data-native-route-id") || "",
        dataState: node.getAttribute("data-native-data-state") || "",
      })
    ),
    bridge: window.__HUSHH_NATIVE_TEST__
      ? {
          bootstrapState: window.__HUSHH_NATIVE_TEST__.bootstrapState || "",
          bootstrapError: window.__HUSHH_NATIVE_TEST__.bootstrapError || "",
          beacon: window.__HUSHH_NATIVE_TEST__.beacon || null,
        }
      : null,
  }));
}

async function waitForRouteBeacon(page, allowedRouteIds, dataStates = TERMINAL_DATA_STATES) {
  await page.waitForFunction(
    ({ routeIds, terminalStates }) => {
      const beacons = Array.from(
        document.querySelectorAll("[data-native-test-beacon='true']")
      );
      const beacon = beacons.find((node) =>
        routeIds.includes(node.getAttribute("data-native-route-id") || "")
      );
      if (!beacon) return false;
      const state = beacon.getAttribute("data-native-data-state") || "";
      return terminalStates.includes(state);
    },
    {
      routeIds: allowedRouteIds,
      terminalStates: dataStates,
    },
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
}

async function ensureReviewerSession(page) {
  process.stdout.write("[kai-import-e2e] bootstrap reviewer session\n");
  await page.goto(
    `${appOrigin}/login?redirect=${encodeURIComponent(REVIEWER_BOOTSTRAP_ROUTE)}`,
    { waitUntil: "domcontentloaded" }
  );

  const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
  await page.waitForFunction(
    () => {
      const bridge = window.__HUSHH_NATIVE_TEST__;
      const bootstrapState = bridge?.bootstrapState || "";
      if (window.location.pathname === "/ria") return true;
      if (
        bootstrapState === "authenticated" ||
        bootstrapState === "loading_vault_state" ||
        bootstrapState === "unlocking_vault" ||
        bootstrapState === "vault_unlocked"
      ) {
        return true;
      }
      if (document.querySelector("#unlock-passphrase")) return true;
      return Array.from(document.querySelectorAll("button")).some((button) =>
        /continue as reviewer/i.test((button.textContent || "").trim())
      );
    },
    {},
    { timeout: 60_000 }
  );

  if (await reviewerButton.isVisible().catch(() => false)) {
    await reviewerButton.click();
  }

  try {
    await page.waitForURL(
      (url) =>
        url.pathname === REVIEWER_BOOTSTRAP_ROUTE ||
        url.pathname.startsWith(`${REVIEWER_BOOTSTRAP_ROUTE}/`),
      { timeout: NAVIGATION_TIMEOUT_MS }
    );
  } catch (error) {
    throw new Error(
      `Reviewer login timed out. ${JSON.stringify(await captureDiagnostics(page), null, 2)}`,
      { cause: error }
    );
  }

  const unlockInput = page.locator("#unlock-passphrase");
  await unlockInput.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await unlockInput.isVisible().catch(() => false)) {
    await unlockInput.fill(reviewerPassphrase);
    const unlockButton = page
      .getByRole("button", { name: /unlock with passphrase/i })
      .first();
    await page.waitForFunction(
      () => {
        const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
          /unlock with passphrase/i.test((candidate.textContent || "").trim())
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      },
      {},
      { timeout: 10_000 }
    );
    await unlockButton.click({ noWaitAfter: true });
    await page.waitForTimeout(3000);
    if (await unlockInput.isVisible().catch(() => false)) {
      throw new Error(
        `Reviewer vault unlock did not complete. ${JSON.stringify(
          await captureDiagnostics(page),
          null,
          2
        )}`
      );
    }
  }

  await waitForRouteBeacon(page, [REVIEWER_BOOTSTRAP_ROUTE]);
}

async function firstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return locator.first();
}

async function waitForVisibleTourId(page, tourId, timeout = 15_000) {
  const target = await firstVisible(page.locator(`[data-tour-id="${tourId}"]`));
  return target.waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
}

async function clickBottomNav(page, label) {
  const navTourIdsByLabel = {
    Market: ["nav-market"],
    Portfolio: ["nav-portfolio"],
    Profile: ["nav-profile"],
  };
  for (const tourId of navTourIdsByLabel[label] || []) {
    const byTourId = page.locator(`[data-tour-id="${tourId}"]`);
    const visible = await byTourId
      .first()
      .waitFor({ state: "attached", timeout: NAVIGATION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!visible) continue;
    const target = await firstVisible(byTourId);
    if (await target.isVisible().catch(() => false)) {
      await target.evaluate((node) => {
        if (node instanceof HTMLElement) node.click();
      });
      return;
    }
  }

  const roleButton = await firstVisible(
    page.getByRole("button", { name: new RegExp(`^${label}$`, "i") })
  );
  if (await roleButton.isVisible().catch(() => false)) {
    await roleButton.click();
    return;
  }

  const link = await firstVisible(
    page.getByRole("link", { name: new RegExp(`^${label}$`, "i") })
  );
  if (await link.isVisible().catch(() => false)) {
    await link.click();
    return;
  }

  const radio = page.getByRole("radio", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await radio.isVisible().catch(() => false)) {
    await radio.evaluate((node) => {
      if (node instanceof HTMLElement) node.click();
    });
    return;
  }

  const tab = page.getByRole("tab", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.evaluate((node) => {
      if (node instanceof HTMLElement) node.click();
    });
    return;
  }

  const text = page.getByText(new RegExp(`^${label}$`, "i")).first();
  if (await text.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false)) {
    await text.click({ force: true });
    return;
  }

  const visibleTourIds = await page
    .locator("[data-tour-id]")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
        .map((node) => node.getAttribute("data-tour-id"))
        .filter(Boolean)
    )
    .catch(() => []);
  throw new Error(
    `Cannot find bottom navigation item "${label}" at ${page.url()}. Visible tour ids: ${visibleTourIds.join(", ")}`
  );
}

async function ensureInvestorPersona(page) {
  await page
    .waitForFunction(
      () => typeof window.__HUSHH_NATIVE_TEST__?.switchPersona === "function",
      {},
      { timeout: 10_000 }
    )
    .catch(() => {});

  const switchedWithBridge = await page
    .evaluate(() => {
      if (typeof window.__HUSHH_NATIVE_TEST__?.switchPersona !== "function") {
        return false;
      }
      window.__HUSHH_NATIVE_TEST__.switchPersona("investor");
      return true;
    })
    .catch(() => false);

  if (switchedWithBridge) {
    await page
      .waitForFunction(
        () => window.__HUSHH_NATIVE_TEST__?.activePersona === "investor",
        {},
        { timeout: 10_000 }
      )
      .catch(() => {});
  }

  const stayInInvestorWorkspace = page.getByRole("button", {
    name: /stay in (?:investor|kai) workspace/i,
  });
  if (await stayInInvestorWorkspace.isVisible().catch(() => false)) {
    await stayInInvestorWorkspace.click();
    await page.waitForTimeout(1000);
  }

  if (await waitForVisibleTourId(page, "nav-market", 5000)) {
    return;
  }

  await page.goto(`${appOrigin}/kai`, { waitUntil: "domcontentloaded" });
  if (await stayInInvestorWorkspace.isVisible().catch(() => false)) {
    await stayInInvestorWorkspace.click();
    await page.waitForTimeout(1000);
  }
  if (!(await waitForVisibleTourId(page, "nav-market", 15_000))) {
    throw new Error(
      `Cannot align reviewer session to investor persona. ${JSON.stringify(
        await captureDiagnostics(page),
        null,
        2
      )}`
    );
  }
}

async function clearImportBackgroundState(page) {
  await page.evaluate((keys) => {
    for (const key of keys) {
      window.sessionStorage.removeItem(key);
      window.localStorage.removeItem(key);
    }
  }, IMPORT_BACKGROUND_KEYS);
}

function classifyUrl(url) {
  const value = String(url);
  if (value.includes("/api/kai/portfolio/import/run/start")) return "import_run_start";
  if (value.includes("/api/kai/portfolio/import/run/active")) return "import_run_active";
  if (value.includes("/api/kai/portfolio/import/run/") && value.includes("/stream")) {
    return "import_run_stream";
  }
  if (value.includes("/api/kai/portfolio/import/stream")) return "import_stream";
  if (value.includes("/api/kai/portfolio/import")) return "legacy_import";
  if (value.includes("/api/pkm/store-domain/validate")) return "pkm_store_validate";
  if (value.includes("/api/pkm/store-domain")) return "pkm_store_domain";
  if (value.includes("/api/pkm/domain-data/") && /\/financial(?:[/?#]|$)/.test(value)) {
    return "pkm_financial_readback";
  }
  return "";
}

function createNetworkMonitor(page) {
  const requestStarts = new Map();
  const events = [];

  const onRequest = (request) => {
    const kind = classifyUrl(request.url());
    if (!kind) return;
    requestStarts.set(request, Date.now());
  };

  const onResponse = (response) => {
    const kind = classifyUrl(response.url());
    if (!kind) return;
    const request = response.request();
    const startedAt = requestStarts.get(request) || Date.now();
    requestStarts.delete(request);
    events.push({
      kind,
      method: request.method(),
      status: response.status(),
      ok: response.ok(),
      elapsedMs: Date.now() - startedAt,
    });
  };

  const onRequestFailed = (request) => {
    const kind = classifyUrl(request.url());
    if (!kind) return;
    const startedAt = requestStarts.get(request) || Date.now();
    requestStarts.delete(request);
    events.push({
      kind,
      method: request.method(),
      status: 0,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      failure: request.failure()?.errorText || "failed",
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return {
    events,
    dispose() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    },
  };
}

function summarizeEvents(events) {
  return events.reduce((summary, event) => {
    const key = event.kind;
    if (!summary[key]) {
      summary[key] = { count: 0, ok: 0, failed: 0, statuses: {} };
    }
    summary[key].count += 1;
    if (event.ok) summary[key].ok += 1;
    else summary[key].failed += 1;
    const statusKey = String(event.status);
    summary[key].statuses[statusKey] = (summary[key].statuses[statusKey] || 0) + 1;
    return summary;
  }, {});
}

async function navigateToKaiImport(page) {
  await ensureInvestorPersona(page);
  await clickBottomNav(page, "Market");
  await waitForRouteBeacon(page, ["/kai"]);
  await clickBottomNav(page, "Portfolio");
  await waitForRouteBeacon(page, ["/kai/portfolio"]);

  const importButton = await firstVisible(
    page.getByRole("button", {
      name: /^(upload statement|import statement|import portfolio|connect portfolio)$/i,
    })
  );
  await importButton.click();
  await waitForRouteBeacon(page, ["/kai/import"]);
  await clearImportBackgroundState(page);
}

async function waitForImportCompletion(page) {
  const reviewButton = page.getByRole("button", { name: /review extracted portfolio/i });
  const failureText = page.getByText(
    /import failed|could not import|could not parse|parse failed|stalled/i
  );
  const result = await Promise.race([
    reviewButton.waitFor({ state: "visible", timeout: IMPORT_TIMEOUT_MS }).then(() => "done"),
    failureText.waitFor({ state: "visible", timeout: IMPORT_TIMEOUT_MS }).then(() => "failed"),
  ]);
  if (result === "failed") {
    throw new Error(`Import failed before review. ${JSON.stringify(await captureDiagnostics(page), null, 2)}`);
  }
  return reviewButton;
}

async function extractHoldingsCount(page) {
  const holdingsLabel = page.getByText(/Holdings\s*\(\d+\)/i).first();
  await holdingsLabel.waitFor({ state: "visible", timeout: 60_000 });
  const label = (await holdingsLabel.textContent()) || "";
  const count = Number(label.match(/Holdings\s*\((\d+)\)/i)?.[1] || 0);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`Expected positive holdings count, saw "${label}"`);
  }
  return count;
}

async function runImportAndSave(page, network) {
  await navigateToKaiImport(page);
  await page.locator("input[type='file']").setInputFiles(importFilePath);
  const startResponse = page.waitForResponse(
    (response) => {
      const kind = classifyUrl(response.url());
      return kind === "import_run_start" || kind === "import_stream";
    },
    { timeout: 60_000 }
  );
  await page.getByRole("button", { name: /^Continue$/i }).click();
  const start = await startResponse;
  if (!start.ok()) {
    throw new Error(`Import stream start failed with HTTP ${start.status()}`);
  }

  const reviewButton = await waitForImportCompletion(page);
  await reviewButton.click();
  await page.getByRole("heading", { name: /review portfolio/i }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  const holdingsCount = await extractHoldingsCount(page);

  const storeResponsePromise = page.waitForResponse(
    (response) => classifyUrl(response.url()) === "pkm_store_domain",
    { timeout: 120_000 }
  );
  const saveButton = await firstVisible(
    page.getByRole("button", { name: /^(save to vault|create vault)$/i })
  );
  await saveButton.click();
  const storeResponse = await storeResponsePromise;
  if (!storeResponse.ok()) {
    throw new Error(`PKM store-domain failed with HTTP ${storeResponse.status()}`);
  }

  await page
    .waitForURL((url) => url.pathname === "/kai/portfolio", { timeout: 120_000 })
    .catch(async (error) => {
      throw new Error(
        `Did not return to portfolio after save. ${JSON.stringify(
          await captureDiagnostics(page),
          null,
          2
        )}`,
        { cause: error }
      );
    });
  await waitForRouteBeacon(page, ["/kai/portfolio"]);

  return {
    holdingsCount,
    endpointSummary: summarizeEvents(network.events),
  };
}

async function verifyFreshDbReadback(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const network = createNetworkMonitor(page);
  await installNativeTestBridge(page);

  try {
    await ensureReviewerSession(page);
    await ensureInvestorPersona(page);

    await clickBottomNav(page, "Portfolio");
    await waitForRouteBeacon(page, ["/kai/portfolio"]);

    const observedReadback = network.events.find(
      (event) => event.kind === "pkm_financial_readback" && event.ok
    );
    if (!observedReadback) {
      const readbackResponse = await page.waitForResponse(
        (response) => classifyUrl(response.url()) === "pkm_financial_readback",
        { timeout: 30_000 }
      );
      if (!readbackResponse.ok()) {
        throw new Error(`PKM financial read-back failed with HTTP ${readbackResponse.status()}`);
      }
    }

    const pageText = await page.locator("body").innerText().catch(() => "");
    const hasPortfolioSignal = /holdings|portfolio value|assets|positions/i.test(pageText);
    const hasEmptyPortfolioSignal = /import your portfolio|no holdings yet/i.test(pageText);
    if (!hasPortfolioSignal || hasEmptyPortfolioSignal) {
      throw new Error(
        "Fresh session did not render a portfolio/holdings screen after PKM financial read-back."
      );
    }

    return {
      endpointSummary: summarizeEvents(network.events),
    };
  } finally {
    network.dispose();
    await context.close();
  }
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const importFileStat = assertImportFile();
  const server = startDevServerIfNeeded();
  await server.ensure();

  const browser = await chromium.launch({ headless });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    appOrigin,
    importFile: {
      basename: UI_FILE_NAME,
      bytes: importFileStat.size,
    },
    phases: {},
  };

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await installNativeTestBridge(page);
    const network = createNetworkMonitor(page);

    try {
      await ensureReviewerSession(page);
      const startedAt = Date.now();
      const importResult = await runImportAndSave(page, network);
      report.phases.importAndSave = {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        holdingsCount: importResult.holdingsCount,
        endpointSummary: importResult.endpointSummary,
      };
    } finally {
      network.dispose();
      await context.close();
    }

    const readbackStartedAt = Date.now();
    const readbackResult = await verifyFreshDbReadback(browser);
    report.phases.freshReadback = {
      ok: true,
      elapsedMs: Date.now() - readbackStartedAt,
      endpointSummary: readbackResult.endpointSummary,
    };
    report.ok = true;
    writeReport(report);

    process.stdout.write(
      `[kai-import-e2e] PASS holdings=${report.phases.importAndSave.holdingsCount} report=${reportPath}\n`
    );
  } catch (error) {
    report.error = error?.message || String(error);
    writeReport(report);
    throw error;
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`[kai-import-e2e] FAIL ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
