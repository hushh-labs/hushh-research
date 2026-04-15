#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

import dotenv from "dotenv";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(webDir, "..");
const contractPath = path.join(webDir, "lib", "navigation", "app-route-layout.contract.json");
const webEnvPath = path.join(webDir, ".env.local");
const protocolEnvPath = path.join(repoRoot, "consent-protocol", ".env");

dotenv.config({ path: webEnvPath });
dotenv.config({ path: protocolEnvPath, override: false });

function sanitizeConfiguredValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/replace_with_/i.test(trimmed)) return "";
  if (/your_[a-z0-9_]+_here/i.test(trimmed)) return "";
  return trimmed;
}

const appOrigin = (
  process.env.HUSHH_APP_ORIGIN ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_FRONTEND_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const routeFilter = String(process.env.HUSHH_ROUTE_FILTER || "").trim().toLowerCase();
const viewportFilter = String(process.env.HUSHH_VIEWPORT_FILTER || "").trim().toLowerCase();
const reviewerPassphrase =
  process.env.HUSHH_KAI_TEST_PASSPHRASE ||
  process.env.KAI_TEST_PASSPHRASE ||
  "test#123";
const kaiTestUserId =
  sanitizeConfiguredValue(process.env.NEXT_PUBLIC_KAI_TEST_USER_ID) ||
  "s3xmA4lNSAQFrIaOytnSGAOzXlL2";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, isMobile: true },
  { name: "tablet", width: 834, height: 1112, isMobile: true },
  { name: "laptop", width: 1440, height: 900, isMobile: false },
  { name: "desktop", width: 1728, height: 1117, isMobile: false },
];
const NAVIGATION_TIMEOUT_MS = 120000;
const REVIEWER_BOOTSTRAP_ROUTE = "/ria";

const TERMINAL_DATA_STATES = new Set([
  "loaded",
  "empty-valid",
  "unavailable-valid",
  "redirect-valid",
  "error",
]);

const DYNAMIC_ROUTE_FIXTURES = {
  "/ria/clients/[userId]": {
    path: `/ria/clients/${kaiTestUserId}?tab=overview&test_profile=1`,
    expectedPathname: `/ria/clients/${kaiTestUserId}`,
    expectedQueryIncludes: ["tab=overview", "test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]"],
    requireBackButton: false,
  },
  "/ria/clients/[userId]/accounts/[accountId]": {
    path: `/ria/clients/${kaiTestUserId}/accounts/acct_demo_taxable_main?test_profile=1`,
    expectedPathname: `/ria/clients/${kaiTestUserId}/accounts/acct_demo_taxable_main`,
    expectedQueryIncludes: ["test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]/accounts/[accountId]"],
    requireBackButton: true,
  },
  "/ria/clients/[userId]/requests/[requestId]": {
    path: `/ria/clients/${kaiTestUserId}/requests/request_demo_kai_specialized_bundle?test_profile=1`,
    expectedPathname: `/ria/clients/${kaiTestUserId}/requests/request_demo_kai_specialized_bundle`,
    expectedQueryIncludes: ["test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]/requests/[requestId]"],
    requireBackButton: true,
  },
};

const ROUTE_OVERRIDES = {
  "/kai/onboarding": {
    allowedPathnames: ["/kai/onboarding", "/kai"],
    allowedRouteIds: ["/kai/onboarding", "/kai"],
  },
  "/ria/onboarding": {
    allowedPathnames: ["/ria/onboarding", "/ria"],
    allowedRouteIds: ["/ria/onboarding", "/ria"],
  },
};

const REDIRECT_EXPECTATIONS = {
  "/kai/dashboard": {
    path: "/kai/dashboard",
    expectedPathname: "/kai/portfolio",
    allowedRouteIds: ["/kai/portfolio"],
  },
  "/kai/dashboard/analysis": {
    path: "/kai/dashboard/analysis",
    expectedPathname: "/kai/analysis",
    allowedRouteIds: ["/kai/analysis"],
  },
  "/marketplace/connections": {
    path: "/marketplace/connections",
    expectedPathname: "/consents",
    allowedRouteIds: ["/consents"],
  },
  "/marketplace/connections/portfolio": {
    path: "/marketplace/connections/portfolio",
    expectedPathname: "/ria/clients",
    allowedRouteIds: ["/ria/clients"],
  },
  "/ria/requests": {
    path: "/ria/requests",
    expectedPathname: "/consents",
    allowedRouteIds: ["/consents"],
  },
  "/ria/settings": {
    path: "/ria/settings",
    expectedPathname: "/profile",
    allowedRouteIds: ["/profile"],
  },
  "/ria/workspace": {
    path: `/ria/workspace?clientId=${encodeURIComponent(kaiTestUserId)}&tab=overview&test_profile=1`,
    expectedPathname: `/ria/clients/${kaiTestUserId}`,
    expectedQueryIncludes: ["tab=overview", "test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]"],
  },
};

function loadRouteContract() {
  return JSON.parse(fs.readFileSync(contractPath, "utf8"));
}

function shouldIncludeRoute(route) {
  if (route.mode === "hidden") return false;
  if (!routeFilter) return true;
  return route.route.toLowerCase().includes(routeFilter);
}

function includedViewports() {
  if (!viewportFilter) return VIEWPORTS;
  return VIEWPORTS.filter((viewport) => viewport.name.includes(viewportFilter));
}

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

async function waitForHttp(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await httpStatus(url);
      if (status >= 200 && status < 500) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function canReach(url) {
  try {
    const status = await httpStatus(url);
    return status >= 200 && status < 500;
  } catch {
    return false;
  }
}

function startDevServerIfNeeded() {
  let child = null;
  return {
    async ensure() {
      const loginUrl = `${appOrigin}/login`;
      if (await canReach(loginUrl)) {
        return null;
      }

      child = spawn("npm", ["run", "dev"], {
        cwd: webDir,
        env: { ...process.env },
        stdio: "pipe",
      });

      child.stdout?.on("data", (chunk) => {
        process.stdout.write(String(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        process.stderr.write(String(chunk));
      });

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

function routeSpec(route) {
  if (route.mode === "redirect") {
    const expectation = REDIRECT_EXPECTATIONS[route.route];
    if (!expectation) {
      throw new Error(`Missing redirect expectation for ${route.route}`);
    }
    return {
      kind: "redirect",
      route: route.route,
      ...expectation,
    };
  }

  const fixture = DYNAMIC_ROUTE_FIXTURES[route.route];
  const override = ROUTE_OVERRIDES[route.route];
  return {
    kind: route.mode,
    route: route.route,
    path: fixture?.path || route.route,
    expectedPathname: fixture?.expectedPathname || route.route,
    expectedQueryIncludes: fixture?.expectedQueryIncludes || [],
    allowedPathnames: override?.allowedPathnames || [fixture?.expectedPathname || route.route],
    allowedRouteIds: override?.allowedRouteIds || fixture?.allowedRouteIds || [route.route],
    requireBackButton: Boolean(fixture?.requireBackButton),
  };
}

async function ensureReviewerSession(page) {
  process.stdout.write(`→ bootstrap reviewer session\n`);
  await page.goto(
    `${appOrigin}/login?redirect=${encodeURIComponent(REVIEWER_BOOTSTRAP_ROUTE)}`,
    { waitUntil: "domcontentloaded" }
  );

  const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
  await page.waitForFunction(
    () => {
      if (window.location.pathname === "/ria") {
        return true;
      }
      if (document.querySelector("#unlock-passphrase")) {
        return true;
      }
      return Array.from(document.querySelectorAll("button")).some((button) =>
        /continue as reviewer/i.test((button.textContent || "").trim())
      );
    },
    {},
    { timeout: 20_000 }
  );

  if (await reviewerButton.isVisible().catch(() => false)) {
    process.stdout.write(`→ click reviewer login\n`);
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
    const diagnostics = await captureRouteDiagnostics(page);
    throw new Error(
      `Reviewer session login timed out.\n${JSON.stringify(diagnostics, null, 2)}`,
      { cause: error }
    );
  }

  const unlockInput = page.locator("#unlock-passphrase");
  await unlockInput.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await unlockInput.isVisible().catch(() => false)) {
    process.stdout.write(`→ unlock vault with passphrase\n`);
    await unlockInput.click();
    await unlockInput.fill(reviewerPassphrase);
    await page.getByRole("button", { name: /unlock with passphrase/i }).click();
    try {
      await page.waitForFunction(
        () => !document.querySelector("#unlock-passphrase"),
        {},
        { timeout: NAVIGATION_TIMEOUT_MS }
      );
    } catch (error) {
      const diagnostics = await captureRouteDiagnostics(page);
      throw new Error(
        `Reviewer vault unlock timed out.\n${JSON.stringify(diagnostics, null, 2)}`,
        { cause: error }
      );
    }
  }

  try {
    await waitForRouteBeacon(page, [REVIEWER_BOOTSTRAP_ROUTE]);
  } catch (error) {
    const diagnostics = await captureRouteDiagnostics(page);
    throw new Error(
      `Reviewer session route did not stabilize.\n${JSON.stringify(diagnostics, null, 2)}`,
      { cause: error }
    );
  }
  process.stdout.write(`✓ reviewer session ready\n`);
}

async function ensurePersona(page, persona) {
  const titleTrigger = page.getByTestId("top-app-bar-title");
  const label = persona === "ria" ? "RIA" : "Investor";
  const currentTitle = (await titleTrigger.textContent().catch(() => "")) || "";
  if (currentTitle.includes(label)) {
    return;
  }
  await titleTrigger.click();
  await page.getByRole("menuitem", { name: new RegExp(`^${label}$`, "i") }).click();
  await page.waitForTimeout(1500);
}

async function clickBottomNav(page, label) {
  await page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).click();
}

async function openRiaWorkspace(page) {
  await ensurePersona(page, "ria");
  await clickBottomNav(page, "Clients");
  await waitForRouteBeacon(page, ["/ria/clients"]);
  await page.getByRole("button", { name: /kai test user/i }).click();
  await waitForRouteBeacon(page, ["/ria/clients/[userId]"]);
}

async function navigateViaShell(page, spec) {
  switch (spec.route) {
    case "/ria":
      await ensurePersona(page, "ria");
      return true;
    case "/ria/clients":
      await ensurePersona(page, "ria");
      await clickBottomNav(page, "Clients");
      return true;
    case "/ria/picks":
      await ensurePersona(page, "ria");
      await clickBottomNav(page, "Picks");
      return true;
    case "/marketplace":
      await ensurePersona(page, "ria");
      await clickBottomNav(page, "Connect");
      return true;
    case "/profile":
      await clickBottomNav(page, "Profile");
      return true;
    case "/consents":
      await openRiaWorkspace(page);
      await page.getByRole("button", { name: /^access$/i }).click();
      await page.getByRole("link", { name: /open access manager/i }).first().click();
      return true;
    case "/ria/clients/[userId]":
      await openRiaWorkspace(page);
      return true;
    case "/ria/clients/[userId]/accounts/[accountId]":
      await openRiaWorkspace(page);
      await page.getByRole("button", { name: /taxable brokerage/i }).click();
      return true;
    case "/ria/clients/[userId]/requests/[requestId]":
      await openRiaWorkspace(page);
      await page.getByRole("button", { name: /^access$/i }).click();
      await page.getByRole("button", { name: /portfolio/i }).first().click();
      return true;
    case "/kai":
      await ensurePersona(page, "investor");
      await clickBottomNav(page, "Market");
      return true;
    case "/kai/portfolio":
      await ensurePersona(page, "investor");
      await clickBottomNav(page, "Portfolio");
      return true;
    case "/kai/analysis":
      await ensurePersona(page, "investor");
      await clickBottomNav(page, "Analysis");
      return true;
    default:
      return false;
  }
}

async function waitForRouteBeacon(page, allowedRouteIds) {
  await page.waitForFunction(
    ({ routeIds, terminalStates }) => {
      const beacons = Array.from(
        document.querySelectorAll("[data-native-test-beacon='true']")
      );
      const beacon = beacons.find((node) =>
        routeIds.includes(node.getAttribute("data-native-route-id") || "")
      );
      if (!beacon) {
        return false;
      }
      const state = beacon.getAttribute("data-native-data-state") || "";
      return terminalStates.includes(state);
    },
    {
      routeIds: allowedRouteIds,
      terminalStates: [...TERMINAL_DATA_STATES],
    },
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
}

function collectPageIssues(page) {
  const issues = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
  };

  const onConsole = (message) => {
    if (message.type() === "error") {
      issues.consoleErrors.push(message.text());
    }
  };

  const onPageError = (error) => {
    issues.pageErrors.push(error?.message || String(error));
  };

  const onRequestFailed = (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const failureText = request.failure()?.errorText || "failed";
    if (failureText.includes("ERR_ABORTED")) return;
    if (
      failureText.includes("ERR_BLOCKED_BY_ORB") &&
      url.startsWith("https://www.googletagmanager.com/")
    ) {
      return;
    }
    issues.requestFailures.push(`${request.method()} ${url} :: ${failureText}`);
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);

  return {
    issues,
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
    },
  };
}

function assertNoIssues(route, viewport, issues) {
  const failures = [
    ...issues.consoleErrors.map((value) => `console:${value}`),
    ...issues.pageErrors.map((value) => `pageerror:${value}`),
    ...issues.requestFailures.map((value) => `requestfailed:${value}`),
  ];
  if (failures.length > 0) {
    throw new Error(`[${viewport}] ${route} browser health failure:\n${failures.join("\n")}`);
  }
}

function assertUrl(spec, finalUrl) {
  const current = new URL(finalUrl);
  if (!spec.allowedPathnames.includes(current.pathname)) {
    throw new Error(
      `${spec.route} resolved to ${current.pathname}${current.search}, expected ${spec.allowedPathnames.join(" or ")}`
    );
  }
  for (const requiredQuery of spec.expectedQueryIncludes || []) {
    if (!current.search.includes(requiredQuery)) {
      throw new Error(`${spec.route} missing expected query fragment "${requiredQuery}" in ${current.search}`);
    }
  }
  if (spec.expectedPathname && current.pathname !== spec.expectedPathname && spec.kind === "redirect") {
    throw new Error(`${spec.route} did not redirect to ${spec.expectedPathname}. Final URL was ${finalUrl}`);
  }
}

async function captureRouteDiagnostics(page) {
  return page.evaluate(() => ({
    url: window.location.href,
    readyState: document.readyState,
    bodySnippet: (document.body?.innerText || "").trim().slice(0, 500),
    beacons: Array.from(document.querySelectorAll("[data-native-test-beacon='true']")).map((node) => ({
      routeId: node.getAttribute("data-native-route-id") || "",
      dataState: node.getAttribute("data-native-data-state") || "",
      marker: node.getAttribute("data-testid") || "",
    })),
    bridge: window.__HUSHH_NATIVE_TEST__
      ? {
          bootstrapState: window.__HUSHH_NATIVE_TEST__.bootstrapState || "",
          bootstrapUserId: window.__HUSHH_NATIVE_TEST__.bootstrapUserId || "",
          bootstrapError: window.__HUSHH_NATIVE_TEST__.bootstrapError || "",
          beacon: window.__HUSHH_NATIVE_TEST__.beacon || null,
        }
      : null,
  }));
}

async function verifyRoute(page, viewport, spec) {
  const { issues, dispose } = collectPageIssues(page);
  try {
    const usedShellNav = await navigateViaShell(page, spec);
    if (!usedShellNav) {
      const targetUrl = `${appOrigin}${spec.path}`;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }

    const unlockInput = page.locator("#unlock-passphrase");
    if (await unlockInput.isVisible().catch(() => false)) {
      throw new Error(`${spec.route} relocked the vault unexpectedly`);
    }

    try {
      await waitForRouteBeacon(page, spec.allowedRouteIds);
    } catch (error) {
      const diagnostics = await captureRouteDiagnostics(page);
      throw new Error(
        `${spec.route} route beacon timed out.\n${JSON.stringify(diagnostics, null, 2)}`,
        { cause: error }
      );
    }
    assertUrl(spec, page.url());

    if (spec.requireBackButton) {
      await page.getByLabel(/go back/i).waitFor({ state: "visible", timeout: 15000 });
    }

    assertNoIssues(spec.route, viewport, issues);
  } finally {
    dispose();
  }
}

async function verifyRiaWorkspaceFlow(page, viewport) {
  const { issues, dispose } = collectPageIssues(page);
  try {
    await page.goto(`${appOrigin}/ria/clients`, { waitUntil: "domcontentloaded" });
    await waitForRouteBeacon(page, ["/ria/clients"]);
    await page.getByRole("button", { name: /kai test user/i }).click();
    await waitForRouteBeacon(page, ["/ria/clients/[userId]"]);

    await page.getByRole("button", { name: /taxable brokerage/i }).click();
    await waitForRouteBeacon(page, ["/ria/clients/[userId]/accounts/[accountId]"]);
    await page.getByLabel(/go back/i).click();
    await waitForRouteBeacon(page, ["/ria/clients/[userId]"]);

    await page.getByRole("button", { name: /^access$/i }).click();
    await page.getByTestId("ria-client-workspace-access").waitFor({ state: "visible", timeout: 15000 });
    await page.getByRole("link", { name: /open access manager/i }).first().click();
    await waitForRouteBeacon(page, ["/consents"]);

    assertNoIssues("ria-workspace-flow", viewport, issues);
  } finally {
    dispose();
  }
}

async function verifyMarketplaceFlow(page, viewport) {
  const { issues, dispose } = collectPageIssues(page);
  try {
    await page.goto(`${appOrigin}/marketplace`, { waitUntil: "domcontentloaded" });
    await waitForRouteBeacon(page, ["/marketplace"]);

    const openWorkspace = page.getByRole("button", { name: /open workspace/i }).first();
    await openWorkspace.click();
    await waitForRouteBeacon(page, ["/ria/clients/[userId]"]);

    assertNoIssues("marketplace-workspace-flow", viewport, issues);
  } finally {
    dispose();
  }
}

async function runViewportSweep(viewport, contract) {
  const browser = await chromium.launch({ headless: true });
  let context = null;
  let page = null;

  try {
    let bootstrapError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      context = await browser.newContext({ viewport });
      page = await context.newPage();
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      try {
        await ensureReviewerSession(page);
        bootstrapError = null;
        break;
      } catch (error) {
        bootstrapError = error;
        await context.close();
        context = null;
        page = null;
      }
    }

    if (!page || bootstrapError) {
      throw bootstrapError || new Error(`Failed to bootstrap reviewer session for ${viewport.name}`);
    }

    for (const route of contract.filter(shouldIncludeRoute)) {
      const spec = routeSpec(route);
      process.stdout.write(`→ [${viewport.name}] ${route.route}\n`);
      await verifyRoute(page, viewport.name, spec);
      process.stdout.write(`✓ [${viewport.name}] ${route.route}\n`);
    }

    await verifyRiaWorkspaceFlow(page, viewport.name);
    process.stdout.write(`✓ [${viewport.name}] ria workspace flow\n`);
    await verifyMarketplaceFlow(page, viewport.name);
    process.stdout.write(`✓ [${viewport.name}] marketplace workspace flow\n`);
  } finally {
    if (context) {
      await context.close();
    }
    await browser.close();
  }
}

async function main() {
  const server = startDevServerIfNeeded();
  const startedChild = await server.ensure();
  const contract = loadRouteContract();
  const selectedViewports = includedViewports();

  if (selectedViewports.length === 0) {
    throw new Error(`No viewport matched HUSHH_VIEWPORT_FILTER=${viewportFilter}`);
  }

  try {
    for (const viewport of selectedViewports) {
      await runViewportSweep(viewport, contract);
    }
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          origin: appOrigin,
          viewports: selectedViewports.map((viewport) => viewport.name),
          routesCovered: contract.filter(shouldIncludeRoute).map((route) => route.route),
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    if (startedChild) {
      await server.stop();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
