#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(webDir, "..");
const contractPath = path.join(webDir, "lib", "navigation", "app-route-layout.contract.json");
const webEnvPath = path.join(webDir, ".env.local");
const protocolEnvPath = path.join(repoRoot, "consent-protocol", ".env");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function seedProcessEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key] && value) {
      process.env[key] = value;
    }
  }
}

const parsedWebEnv = parseEnvFile(webEnvPath);
const parsedProtocolEnv = parseEnvFile(protocolEnvPath);
seedProcessEnv(parsedProtocolEnv);
seedProcessEnv(parsedWebEnv);

function readRawEnvLiteral(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = fs.readFileSync(filePath, "utf8").match(pattern);
  if (!match?.[1]) return "";
  const rawValue = match[1].trim();
  return rawValue.replace(/^['"]|['"]$/g, "");
}

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
  "http://localhost:3000"
).replace(/\/$/, "");
const routeFilter = String(process.env.HUSHH_ROUTE_FILTER || "").trim().toLowerCase();
const viewportFilter = String(process.env.HUSHH_VIEWPORT_FILTER || "").trim().toLowerCase();
const rawProtocolReviewerPassphrase = readRawEnvLiteral(protocolEnvPath, "UAT_SMOKE_PASSPHRASE");
const reviewerPassphrase =
  sanitizeConfiguredValue(process.env.HUSHH_REVIEWER_PASSPHRASE) ||
  sanitizeConfiguredValue(process.env.UAT_SMOKE_PASSPHRASE) ||
  sanitizeConfiguredValue(parsedProtocolEnv.UAT_SMOKE_PASSPHRASE) ||
  sanitizeConfiguredValue(rawProtocolReviewerPassphrase) ||
  "test#123";
const smokeUserId =
  sanitizeConfiguredValue(process.env.HUSHH_SMOKE_USER_ID) ||
  sanitizeConfiguredValue(process.env.UAT_SMOKE_USER_ID) ||
  sanitizeConfiguredValue(parsedProtocolEnv.UAT_SMOKE_USER_ID) ||
  "s3xmA4lNSAQFrIaOytnSGAOzXlL2";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, isMobile: true },
  { name: "tablet", width: 834, height: 1112, isMobile: true },
  { name: "laptop", width: 1440, height: 900, isMobile: false },
  { name: "desktop", width: 1728, height: 1117, isMobile: false },
];
const NAVIGATION_TIMEOUT_MS = 120000;
const REVIEWER_BOOTSTRAP_ROUTE = "/ria";
const SAME_SESSION_SHELL_ROUTES = new Set([
  "/profile",
  "/profile/pkm-agent-lab",
  "/ria",
  "/ria/clients",
  "/ria/picks",
  "/marketplace",
  "/consents",
  "/kai",
  "/kai/portfolio",
  "/kai/analysis",
]);

const TERMINAL_DATA_STATES = new Set([
  "loaded",
  "empty-valid",
  "unavailable-valid",
  "redirect-valid",
  "error",
]);

const DYNAMIC_ROUTE_FIXTURES = {
  "/ria/clients/[userId]": {
    path: `/ria/clients/${smokeUserId}?tab=overview&test_profile=1`,
    expectedPathname: `/ria/clients/${smokeUserId}`,
    expectedQueryIncludes: ["tab=overview", "test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]"],
    requireBackButton: false,
  },
  "/ria/clients/[userId]/accounts/[accountId]": {
    path: `/ria/clients/${smokeUserId}/accounts/acct_demo_taxable_main?test_profile=1`,
    expectedPathname: `/ria/clients/${smokeUserId}/accounts/acct_demo_taxable_main`,
    expectedQueryIncludes: ["test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]/accounts/[accountId]"],
    requireBackButton: true,
  },
  "/ria/clients/[userId]/requests/[requestId]": {
    path: `/ria/clients/${smokeUserId}/requests/request_demo_kai_specialized_bundle?test_profile=1`,
    expectedPathname: `/ria/clients/${smokeUserId}/requests/request_demo_kai_specialized_bundle`,
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
  "/profile/pkm": {
    path: "/profile/pkm",
    expectedPathname: "/profile/pkm-agent-lab",
    allowedRouteIds: ["/profile/pkm-agent-lab"],
    requiresColdEntry: true,
  },
  "/ria/workspace": {
    path: `/ria/workspace?clientId=${encodeURIComponent(smokeUserId)}&tab=overview&test_profile=1`,
    expectedPathname: `/ria/clients/${smokeUserId}`,
    expectedQueryIncludes: ["tab=overview", "test_profile=1"],
    allowedRouteIds: ["/ria/clients/[userId]"],
  },
};

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
      expectedUserId: smokeUserId,
      vaultPassphrase: reviewerPassphrase,
    }
  );
}

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

function shouldRunExtraFlow(flowKey) {
  if (!routeFilter) return true;
  return flowKey.toLowerCase().includes(routeFilter);
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
      const bridge = window.__HUSHH_NATIVE_TEST__;
      const bootstrapState = bridge?.bootstrapState || "";
      if (window.location.pathname === "/ria") {
        return true;
      }
      if (
        bootstrapState === "authenticated" ||
        bootstrapState === "loading_vault_state" ||
        bootstrapState === "unlocking_vault" ||
        bootstrapState === "vault_unlocked"
      ) {
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
    { timeout: 60_000 }
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
    process.stdout.write(`→ fill passphrase\n`);
    await unlockInput.fill(reviewerPassphrase);
    process.stdout.write(`→ resolve unlock button\n`);
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
      { timeout: 5_000 }
    );
    process.stdout.write(`→ dispatch unlock click\n`);
    await unlockButton.click({ noWaitAfter: true });
    process.stdout.write(`→ wait post-submit settle\n`);
    await page.waitForTimeout(3000);
    process.stdout.write(`→ confirm unlock UI hidden\n`);
    if (await unlockInput.isVisible().catch(() => false)) {
      const diagnostics = await captureRouteDiagnostics(page);
      throw new Error(
        `Reviewer vault unlock timed out.\n${JSON.stringify(diagnostics, null, 2)}`
      );
    }
    process.stdout.write(`→ vault unlock submitted\n`);
  }

  process.stdout.write(`→ wait for reviewer route beacon\n`);
  try {
    await waitForRouteBeacon(page, [REVIEWER_BOOTSTRAP_ROUTE]);
  } catch (error) {
    const diagnostics = await captureRouteDiagnostics(page);
    throw new Error(
      `Reviewer session route did not stabilize.\n${JSON.stringify(diagnostics, null, 2)}`,
      { cause: error }
    );
  }
  process.stdout.write(`→ align reviewer persona to ria\n`);
  await ensurePersona(page, "ria");
  process.stdout.write(`→ reviewer route beacon ready\n`);
  process.stdout.write(`✓ reviewer session ready\n`);
}

async function ensurePersona(page, persona) {
  const stayInRiaWorkspace = page.getByRole("button", {
    name: /stay in ria workspace/i,
  });
  const switchToInvestorWorkspace = page.getByRole("button", {
    name: /switch to investor workspace/i,
  });

  if (persona === "ria" && (await stayInRiaWorkspace.isVisible().catch(() => false))) {
    await stayInRiaWorkspace.click();
    await page.waitForTimeout(1500);
    return;
  }

  if (
    persona === "investor" &&
    (await switchToInvestorWorkspace.isVisible().catch(() => false))
  ) {
    await switchToInvestorWorkspace.click();
    await page.waitForTimeout(1500);
    return;
  }

  const titleTrigger = page.getByTestId("top-app-bar-title");
  const label = persona === "ria" ? "RIA" : "Investor";
  const currentTitle = (await titleTrigger.textContent().catch(() => "")) || "";
  if (currentTitle.includes(label)) {
    return;
  }
  await titleTrigger.evaluate((node) => {
    if (node instanceof HTMLElement) {
      node.click();
    }
  });
  await page.getByRole("menuitem", { name: new RegExp(`^${label}$`, "i") }).click();
  await page.waitForTimeout(1500);
}

async function clickBottomNav(page, label) {
  const button = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    });
    return;
  }

  const link = page.getByRole("link", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await link.isVisible().catch(() => false)) {
    await link.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    });
    return;
  }

  const radio = page.getByRole("radio", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await radio.isVisible().catch(() => false)) {
    await radio.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    });
    return;
  }

  const tab = page.getByRole("tab", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    });
    return;
  }

  await page.getByText(new RegExp(`^${label}$`, "i")).first().click({ force: true });
}

async function openRiaWorkspace(page) {
  await ensurePersona(page, "ria");
  await clickBottomNav(page, "Clients");
  await waitForRouteBeacon(page, ["/ria/clients"]);
  const explicitTestProfile = page.getByTestId("ria-client-test-profile").first();
  if (await explicitTestProfile.isVisible().catch(() => false)) {
    await explicitTestProfile.click();
  } else {
    await page.getByRole("button", { name: /kai test user|kushal trivedi/i }).click();
  }
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
    case "/profile/pkm-agent-lab":
      await clickBottomNav(page, "Profile");
      await page.getByRole("button", { name: /pkm agent lab/i }).click();
      return true;
    case "/consents":
      await clickBottomNav(page, "Profile");
      await waitForRouteBeacon(page, ["/profile"]);
      await page.getByRole("button", { name: /access & sharing/i }).click();
      await page.getByRole("button", { name: /consent center/i }).click();
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
    if (spec.requiresColdEntry) {
      process.stdout.write(`↷ [${viewport}] ${spec.route} requires cold-entry verification; skipping from signed-in sweep\n`);
      return;
    }

    const usedShellNav = await navigateViaShell(page, spec);
    if (!usedShellNav) {
      if (SAME_SESSION_SHELL_ROUTES.has(spec.route)) {
        throw new Error(
          `${spec.route} must be proven through reviewer login plus Next client navigation. Add a shell navigation mapping instead of using page.goto(...).`
        );
      }
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
    const explicitTestProfile = page.getByTestId("ria-client-test-profile").first();
    if (await explicitTestProfile.isVisible().catch(() => false)) {
      await explicitTestProfile.click();
    } else {
      await page.getByRole("button", { name: /kai test user|kushal trivedi/i }).click();
    }
    await waitForRouteBeacon(page, ["/ria/clients/[userId]"]);

    await page.getByRole("button", { name: /taxable brokerage/i }).click();
    await waitForRouteBeacon(page, ["/ria/clients/[userId]/accounts/[accountId]"]);
    await page.getByLabel(/go back/i).click();
    await waitForRouteBeacon(page, ["/ria/clients/[userId]"]);

    await page.getByRole("button", { name: /^access$/i }).click();
    await page.getByTestId("ria-client-workspace-access").waitFor({ state: "visible", timeout: 15000 });
    await page.getByRole("link", { name: /open access/i }).first().click();
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
  let context = null;
  let page = null;
  let browser = null;

  try {
    let bootstrapError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport });
      page = await context.newPage();
      await installNativeTestBridge(page);
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      try {
        await ensureReviewerSession(page);
        bootstrapError = null;
        break;
      } catch (error) {
        bootstrapError = error;
        process.stderr.write(
          `bootstrap attempt ${attempt} failed for ${viewport.name}: ${error instanceof Error ? error.message : String(error)}\n`
        );
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        browser = null;
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

    if (shouldRunExtraFlow("ria")) {
      await verifyRiaWorkspaceFlow(page, viewport.name);
      process.stdout.write(`✓ [${viewport.name}] ria workspace flow\n`);
    }
    if (shouldRunExtraFlow("marketplace")) {
      await verifyMarketplaceFlow(page, viewport.name);
      process.stdout.write(`✓ [${viewport.name}] marketplace workspace flow\n`);
    }
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
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
