#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import {
  defaultReviewerIdentityEnvFiles,
  parseEnvFile,
  resolveReviewerTestIdentity,
} from "../testing/reviewer-test-identity.mjs";
import { prepareNativeTestArtifacts } from "./prepare-native-test-artifacts.mjs";

const repoRoot = process.cwd();
const webDir = repoRoot;
const monorepoRoot = path.resolve(webDir, "..");
const inventoryPath = path.join(repoRoot, "native-route-inventory.json");
const reportPath = path.join(repoRoot, "native-ios-parity-report.json");
const screenshotDir = path.join(
  repoRoot,
  process.env.IOS_ROUTE_AUDIT_SCREENSHOT_DIR || "native-ios-screenshots"
);
const derivedDataPath = path.resolve(
  repoRoot,
  process.env.IOS_DERIVED_DATA_PATH || "ios/App/build/DerivedData"
);
const appPath =
  process.env.IOS_APP_PATH ||
  path.join(derivedDataPath, "Build/Products/Debug-iphonesimulator/App.app");
const destination =
  process.env.IOS_TEST_DESTINATION ||
  resolveSimulatorDestination(process.env.IOS_TEST_DEVICE_NAME || "iPhone 14 Plus");
const destinationDeviceId = destination.match(/(?:^|,)id=([^,]+)/)?.[1] || "";
const simulatorDevice = destinationDeviceId || "booted";
const bundleId = "com.hushh.app";
const timeoutMs = Number(process.env.IOS_ROUTE_AUDIT_TIMEOUT_MS || "60000");
const routeFilter = (process.env.IOS_ROUTE_FILTER || "").trim();
const resetStateRoutes = new Set(
  (process.env.IOS_ROUTE_AUDIT_RESET_ROUTES || "/logout,/login")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
);
const reinstallResetRoutes =
  process.env.IOS_ROUTE_AUDIT_REINSTALL_RESET_ROUTES !== "false";
const xcodeProject = "ios/App/App.xcodeproj";
const xcodeScheme = "App";

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir }),
});
const reviewerVaultPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;

function resolveSimulatorDestination(deviceName) {
  try {
    const output = execFileSync(
      "xcrun",
      ["simctl", "list", "devices", "available", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const payload = JSON.parse(output);
    for (const devices of Object.values(payload.devices || {})) {
      const device = devices.find(
        (candidate) => candidate?.name === deviceName && candidate?.isAvailable
      );
      if (device?.udid) {
        return `platform=iOS Simulator,id=${device.udid}`;
      }
    }
  } catch {
    // Fall back to Xcode's destination matching below.
  }

  return `platform=iOS Simulator,name=${deviceName}`;
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function tryRun(cmd, args) {
  try {
    run(cmd, args, { stdio: "ignore" });
  } catch {
    // Best effort cleanup.
  }
}

function ensureSimulatorBooted() {
  if (!destinationDeviceId) {
    return;
  }
  tryRun("xcrun", ["simctl", "boot", destinationDeviceId]);
  run("xcrun", ["simctl", "bootstatus", destinationDeviceId, "-b"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseStatus(raw) {
  return Object.fromEntries(
    raw
      .trim()
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      })
  );
}

const REDACTED_REPORT_STATUS_KEYS = new Set([
  "bootstrap_uid",
  "body",
  "bodySnippet",
  "jserr",
  "jsrej",
]);

function sanitizeStatusForReport(status = {}) {
  return Object.fromEntries(
    Object.entries(status).map(([key, value]) => [
      key,
      REDACTED_REPORT_STATUS_KEYS.has(key) && value ? "<redacted>" : value,
    ])
  );
}

function sanitizeRawForReport(raw) {
  return String(raw || "")
    .split(";")
    .filter(Boolean)
    .map((part) => {
      const [key, ...rest] = part.split("=");
      if (REDACTED_REPORT_STATUS_KEYS.has(key) && rest.join("=")) {
        return `${key}=<redacted>`;
      }
      return part;
    })
    .join(";");
}

function toReportResult(result) {
  return {
    ...result,
    observed: sanitizeStatusForReport(result.observed),
    raw: sanitizeRawForReport(result.raw),
  };
}

function normalizeRoute(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return trimmed || "/";
  }
  try {
    const url = new URL(trimmed, "https://native-audit.local");
    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${pathname}${url.search}`;
  } catch {
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

function matchesRoute(parsedRoute, route) {
  if (route.expectedRoute) {
    return normalizeRoute(parsedRoute) === normalizeRoute(route.expectedRoute);
  }
  if (route.expectedRoutePrefix) {
    return normalizeRoute(parsedRoute).startsWith(
      normalizeRoute(route.expectedRoutePrefix)
    );
  }
  return true;
}

function captureScreenshot(route) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const slug = String(route.route || "unknown")
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+$/, "") || "root";
  const filePath = path.join(screenshotDir, `${slug}.png`);
  tryRun("xcrun", ["simctl", "io", simulatorDevice, "screenshot", filePath]);
  return fs.existsSync(filePath) ? filePath : null;
}

function detectVisible404(status = {}) {
  if ((status.visible404 || "") === "1") {
    return true;
  }
  const body = String(status.body || status.bodySnippet || "");
  return /\b404\b/.test(body) || /\bnot found\b/i.test(body);
}

function launchRoute(route) {
  tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
  if (reinstallResetRoutes && resetStateRoutes.has(route.route)) {
    tryRun("xcrun", ["simctl", "uninstall", simulatorDevice, bundleId]);
    run("xcrun", ["simctl", "install", simulatorDevice, appPath]);
  }
  try {
    const container = run("xcrun", ["simctl", "get_app_container", simulatorDevice, bundleId, "data"]);
    const statusPath = path.join(container, "Documents", "native-test-status.txt");
    if (fs.existsSync(statusPath)) {
      fs.unlinkSync(statusPath);
    }
  } catch {
    // Best effort cleanup.
  }
  const args = ["simctl", "launch", simulatorDevice, bundleId, "-UITestMode", "-UITestInitialRoute", route.initialRoute];
  args.push("-UITestExpectedMarker", route.expectedMarker);
  if (route.expectedRoute) {
    args.push("-UITestExpectedRoute", route.expectedRoute);
  }
  args.push("-UITestAutoReviewerLogin", route.autoReviewerLogin ? "true" : "false");
  args.push("-UITestResetAppState", resetStateRoutes.has(route.route) ? "true" : "false");
  args.push("-UITestVaultPassphrase", reviewerVaultPassphrase);
  args.push("-UITestExpectedUserId", reviewerUid);
  run("xcrun", args);
}

function applyEnvValues(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      process.env[key] = value;
    }
  }
}

function resolveNativeTestBackendUrl() {
  const configured = String(process.env.NEXT_PUBLIC_BACKEND_URL || "").trim();
  if (configured && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(configured)) {
    return configured;
  }

  const uatEnvPath = path.join(repoRoot, ".env.uat.local");
  const uatValues = parseEnvFile(uatEnvPath);
  const uatBackend = String(uatValues.NEXT_PUBLIC_BACKEND_URL || "").trim();
  if (uatBackend) {
    return uatBackend;
  }

  return configured;
}

function ensureNativeTestBuildEnv() {
  const uatEnvPath = path.join(repoRoot, ".env.uat.local");
  const uatValues = parseEnvFile(uatEnvPath);
  const backendUrl = resolveNativeTestBackendUrl();

  if (!backendUrl) {
    throw new Error(
      "native iOS route audit requires NEXT_PUBLIC_BACKEND_URL. Set it in the shell or hushh-webapp/.env.uat.local."
    );
  }

  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(backendUrl)) {
    throw new Error(
      `native iOS route audit cannot use local backend (${backendUrl}). Start the local backend or load hushh-webapp/.env.uat.local before building.`
    );
  }

  applyEnvValues({
    APP_RUNTIME_PROFILE: uatValues.APP_RUNTIME_PROFILE || "uat",
    NEXT_PUBLIC_APP_ENV: uatValues.NEXT_PUBLIC_APP_ENV || "uat",
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    NEXT_PUBLIC_APP_URL: uatValues.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_PASSKEY_RP_ID: uatValues.NEXT_PUBLIC_PASSKEY_RP_ID,
    NEXT_PUBLIC_FIREBASE_API_KEY: uatValues.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: uatValues.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: uatValues.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: uatValues.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
      uatValues.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: uatValues.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_VAPID_KEY: uatValues.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: uatValues.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
    NEXT_PUBLIC_OBSERVABILITY_ENABLED: uatValues.NEXT_PUBLIC_OBSERVABILITY_ENABLED,
    NEXT_PUBLIC_OBSERVABILITY_DEBUG: uatValues.NEXT_PUBLIC_OBSERVABILITY_DEBUG,
    NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE: uatValues.NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE,
  });

  console.log(`==> native test backend: ${backendUrl}`);
}

function buildApp() {
  ensureNativeTestBuildEnv();
  execSync("npm run cap:build", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  prepareNativeTestArtifacts();
  execSync("npm run cap:sync:ios", {
    cwd: repoRoot,
    stdio: "inherit",
  });
  run("xcodebuild", [
    "-project",
    xcodeProject,
    "-scheme",
    xcodeScheme,
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "build",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 20,
  });
}

function waitForStatus(route) {
  const startedAt = Date.now();
  let lastRaw = "";
  let lastParsed = {};
  let lastHeartbeatAt = startedAt;

  while (Date.now() - startedAt < timeoutMs) {
    if (Date.now() - lastHeartbeatAt >= 15000) {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const routeLabel = lastParsed.route || route.initialRoute || route.route;
      const dataState = lastParsed.data || "pending";
      process.stdout.write(` (${elapsedSec}s: ${routeLabel}, data=${dataState})`);
      lastHeartbeatAt = Date.now();
    }
    try {
      const container = run("xcrun", ["simctl", "get_app_container", simulatorDevice, bundleId, "data"]);
      const statusPath = path.join(container, "Documents", "native-test-status.txt");
      if (fs.existsSync(statusPath)) {
        lastRaw = fs.readFileSync(statusPath, "utf8").trim();
        if (lastRaw) {
          lastParsed = parseStatus(lastRaw);
          const readyOk = (lastParsed.ready || "") === "1";
          const markerOk = (lastParsed.marker || "") === route.expectedMarker;
          const routeOk = matchesRoute(lastParsed.route || "", route);
          const authOk = (lastParsed.auth || "") === route.expectedAuth;
          const dataOk = route.allowedDataStates.includes(lastParsed.data || "");
          if (readyOk && markerOk && routeOk && authOk && dataOk) {
            return {
              ok: true,
              status: lastParsed,
              raw: lastRaw,
            };
          }
        }
      }
    } catch {
      // App may still be booting; keep polling.
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  return {
    ok: false,
    status: lastParsed,
    raw: lastRaw,
  };
}

function main() {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const auditedRoutes = inventory.routes
    .filter((route) => route.classification.startsWith("native-required"))
    .filter((route) => !routeFilter || route.route === routeFilter);

  console.log(`==> native iOS route audit (${auditedRoutes.length} routes)`);
  console.log(`==> destination: ${destination}`);

  if (process.env.IOS_ROUTE_AUDIT_SKIP_BUILD !== "true") {
    buildApp();
  } else {
    const backendUrl = resolveNativeTestBackendUrl();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(backendUrl)) {
      throw new Error(
        `IOS_ROUTE_AUDIT_SKIP_BUILD=true but the baked app targets local backend (${backendUrl || "unset"}). Rebuild without skip or load .env.uat.local first.`
      );
    }
    console.log(`==> skipping rebuild (IOS_ROUTE_AUDIT_SKIP_BUILD=true, backend=${backendUrl})`);
  }
  ensureSimulatorBooted();
  tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
  tryRun("xcrun", ["simctl", "uninstall", simulatorDevice, bundleId]);
  run("xcrun", ["simctl", "install", simulatorDevice, appPath]);

  const results = [];

  for (const route of auditedRoutes) {
    process.stdout.write(`   - ${route.route} ... `);
    try {
      launchRoute(route);
      const result = waitForStatus(route);
      const screenshotPath = captureScreenshot(route);
      const visible404 = detectVisible404(result.status);
      tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);

      if (!result.ok) {
        console.log("FAIL");
        results.push({
          route: route.route,
          ok: false,
          visible404,
          screenshotPath,
          expected: route,
          observed: sanitizeStatusForReport(result.status),
          raw: sanitizeRawForReport(result.raw),
        });
        continue;
      }

      if (visible404) {
        console.log("FAIL(404 visible)");
        results.push({
          route: route.route,
          ok: false,
          visible404,
          screenshotPath,
          expected: route,
          observed: sanitizeStatusForReport(result.status),
          raw: sanitizeRawForReport(result.raw),
          error: "visible_404",
        });
        continue;
      }

      console.log("OK");
      results.push({
        route: route.route,
        ok: true,
        visible404,
        screenshotPath,
        expected: route,
        observed: sanitizeStatusForReport(result.status),
        raw: sanitizeRawForReport(result.raw),
      });
    } catch (error) {
      console.log("FAIL");
      results.push({
        route: route.route,
        ok: false,
        expected: route,
        observed: {},
        raw: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    destination,
    screenshot_dir: path.relative(repoRoot, screenshotDir),
    audited_routes: auditedRoutes.length,
    passed_routes: results.filter((result) => result.ok).length,
    failed_routes: results.filter((result) => !result.ok).length,
    visible404_routes: results.filter((result) => result.visible404).length,
    results: results.map(toReportResult),
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`==> report: ${path.relative(repoRoot, reportPath)}`);
  console.log(`==> screenshots: ${path.relative(repoRoot, screenshotDir)}`);
  if (summary.visible404_routes > 0) {
    console.log(
      `==> visible 404 warnings: ${summary.visible404_routes} route(s) showed visible 404/not-found copy`
    );
  }

  if (summary.failed_routes > 0) {
    process.exit(1);
  }
}

main();
