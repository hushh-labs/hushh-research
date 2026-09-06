#!/usr/bin/env node

import fs from "node:fs";
import { applyNativeAuditBuildEnvironment } from "./native-build-environment.mjs";
import path from "node:path";
import { verifyPrebuiltNativeEnvironment } from "./native-build-environment.mjs";
import { execFileSync, execSync } from "node:child_process";
import {
  defaultReviewerIdentityEnvFiles,
  resolveReviewerTestIdentity,
} from "../testing/reviewer-test-identity.mjs";
import { prepareNativeTestArtifacts } from "./prepare-native-test-artifacts.mjs";
import {
  assertNativeArtifactSafe,
  errorClass,
  sanitizeNativeArtifact,
  sanitizeRawStatusForReport,
  sanitizeStatusForReport,
} from "./native-report-sanitizer.mjs";
import {
  isCompleteNativeRouteAuditStatus,
  isSettledNativeRouteAuditSurface,
  nativeRouteAuditProgressKey,
  parseNativeRouteAuditStatus,
} from "./native-route-status.mjs";

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
const noProgressTimeoutMs = Math.min(
  timeoutMs,
  Math.max(
    1_000,
    Number(process.env.IOS_ROUTE_AUDIT_NO_PROGRESS_TIMEOUT_MS || "20000"),
  ),
);
const routeFilter = (process.env.IOS_ROUTE_FILTER || "").trim();
const maxConsecutiveFailures = Math.max(
  1,
  Number(process.env.IOS_ROUTE_AUDIT_MAX_CONSECUTIVE_FAILURES || "3"),
);
const resetStateRoutes = new Set(
  // Simulator uninstall does not clear Firebase's credential material. The
  // anonymous root must therefore launch with the same explicit reset as the
  // anonymous login/logout routes; otherwise it restores the reviewer and
  // deterministically redirects to /one while this audit waits for "/".
  (process.env.IOS_ROUTE_AUDIT_RESET_ROUTES || "/,/logout,/login")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
);
const reinstallResetRoutes =
  process.env.IOS_ROUTE_AUDIT_REINSTALL_RESET_ROUTES !== "false";
const xcodeProject = "ios/App/App.xcodeproj";
const xcodeScheme = "App";

assertDestructiveNativeAuditAllowed();

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir }),
});
const reviewerVaultPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;

function assertDestructiveNativeAuditAllowed() {
  if (process.env.HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT === "true") return;
  throw new Error(
    "This is a destructive cold-start route audit: it resets simulator app state and may reinstall the app. It cannot prove vault or route continuity. Use npm run ios:continuity:local for a normal-session check, or set HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT=true only for an intentional cold audit.",
  );
}

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

function terminateAuditApp() {
  tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    terminateAuditApp();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
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

function sanitizeRawForReport(raw) {
  return sanitizeRawStatusForReport(raw);
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
  terminateAuditApp();
  if (reinstallResetRoutes && resetStateRoutes.has(route.route)) {
    tryRun("xcrun", ["simctl", "uninstall", simulatorDevice, bundleId]);
    run("xcrun", ["simctl", "install", simulatorDevice, appPath]);
  }
  try {
    const container = run("xcrun", ["simctl", "get_app_container", simulatorDevice, bundleId, "data"]);
    const statusPath = path.join(container, "Library", "Caches", "native-test-status.txt");
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
  run("xcrun", args, {
    env: {
      ...process.env,
      SIMCTL_CHILD_HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE: reviewerVaultPassphrase,
      SIMCTL_CHILD_HUSHH_UI_TEST_REVIEWER_UID: reviewerUid,
    },
  });
}

function ensureNativeTestBuildEnv() {
  applyNativeAuditBuildEnvironment(repoRoot);
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
  let lastProgressKey = "";
  let lastProgressAt = startedAt;
  let settledMismatchKey = "";
  let settledMismatchAt = 0;

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
      const statusPath = path.join(container, "Library", "Caches", "native-test-status.txt");
      if (fs.existsSync(statusPath)) {
        const rawStatus = fs.readFileSync(statusPath, "utf8").trim();
        const parsedStatus = parseNativeRouteAuditStatus(rawStatus);
        if (
          isCompleteNativeRouteAuditStatus(parsedStatus, {
            requiresVaultBootstrap: route.expectedAuth === "authenticated",
          })
        ) {
          lastRaw = rawStatus;
          lastParsed = parsedStatus;
          const progressKey = nativeRouteAuditProgressKey(lastParsed);
          if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            lastProgressAt = Date.now();
          }
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

          if (
            isSettledNativeRouteAuditSurface(lastParsed, route) &&
            (!markerOk || !routeOk)
          ) {
            const mismatchKey = `${lastParsed.route}|${lastParsed.marker}|${lastParsed.routeok}`;
            if (
              mismatchKey === settledMismatchKey &&
              Date.now() - settledMismatchAt >= 1_000
            ) {
              return {
                ok: false,
                status: lastParsed,
                raw: lastRaw,
                errorClass: "route_mismatch",
              };
            }
            settledMismatchKey = mismatchKey;
            settledMismatchAt = Date.now();
          } else {
            settledMismatchKey = "";
            settledMismatchAt = 0;
          }
        }
      }
    } catch {
      // App may still be booting; keep polling.
    }

    if (Date.now() - lastProgressAt >= noProgressTimeoutMs) {
      return {
        ok: false,
        status: lastParsed,
        raw: lastRaw,
        errorClass: "stalled",
      };
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  return {
    ok: false,
    status: lastParsed,
    raw: lastRaw,
  };
}

function runAudit() {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const auditedRoutes = inventory.routes
    .filter((route) => route.classification.startsWith("native-required"))
    .filter((route) => !routeFilter || route.route === routeFilter);

  console.log(`==> native iOS route audit (${auditedRoutes.length} routes)`);
  console.log(`==> destination: ${destination}`);
  console.log(`==> failure circuit breaker: ${maxConsecutiveFailures} consecutive route failures`);
  // A prior report is evidence of a prior run, never evidence for this one.
  // Remove it before launch so an interruption cannot be mistaken for a fresh
  // route-audit completion by a developer or a downstream check.
  fs.rmSync(reportPath, { force: true });

  if (process.env.IOS_ROUTE_AUDIT_SKIP_BUILD !== "true") {
    buildApp();
  } else {
    ensureNativeTestBuildEnv();
    verifyPrebuiltNativeEnvironment({ appPath, env: process.env });
    console.log("==> verified prebuilt native backend and Firebase identity");
  }
  ensureSimulatorBooted();
  tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
  tryRun("xcrun", ["simctl", "uninstall", simulatorDevice, bundleId]);
  run("xcrun", ["simctl", "install", simulatorDevice, appPath]);

  const results = [];
  let consecutiveFailures = 0;
  let auditComplete = true;

  for (const route of auditedRoutes) {
    process.stdout.write(`   - ${route.route} ... `);
    try {
      launchRoute(route);
      const result = waitForStatus(route);
      const screenshotPath = captureScreenshot(route);
      const visible404 = detectVisible404(result.status);
      terminateAuditApp();

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
          errorClass: result.errorClass || undefined,
        });
        consecutiveFailures += 1;
      } else if (visible404) {
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
        consecutiveFailures += 1;
      } else {
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
        consecutiveFailures = 0;
      }
    } catch (error) {
      console.log("FAIL");
      results.push({
        route: route.route,
        ok: false,
        expected: route,
        observed: {},
        raw: "",
        errorClass: errorClass(error),
      });
      consecutiveFailures += 1;
    }

    if (consecutiveFailures >= maxConsecutiveFailures) {
      auditComplete = false;
      console.log(
        `==> stopping after ${consecutiveFailures} consecutive route failures`,
      );
      break;
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    destination,
    screenshot_dir: path.relative(repoRoot, screenshotDir),
    audited_routes: auditedRoutes.length,
    completed_routes: results.length,
    audit_complete: auditComplete && results.length === auditedRoutes.length,
    max_consecutive_failures: maxConsecutiveFailures,
    passed_routes: results.filter((result) => result.ok).length,
    failed_routes: results.filter((result) => !result.ok).length,
    visible404_routes: results.filter((result) => result.visible404).length,
    results: results.map(toReportResult),
  };

  const sanitizedSummary = sanitizeNativeArtifact(summary);
  assertNativeArtifactSafe(sanitizedSummary, [reviewerUid, reviewerVaultPassphrase]);
  fs.writeFileSync(reportPath, `${JSON.stringify(sanitizedSummary, null, 2)}\n`);
  console.log(`==> report: ${path.relative(repoRoot, reportPath)}`);
  console.log(`==> screenshots: ${path.relative(repoRoot, screenshotDir)}`);
  if (summary.visible404_routes > 0) {
    console.log(
      `==> visible 404 warnings: ${summary.visible404_routes} route(s) showed visible 404/not-found copy`
    );
  }

  if (!summary.audit_complete || summary.failed_routes > 0) {
    process.exitCode = 1;
  }
}

function main() {
  try {
    runAudit();
  } finally {
    // A host interruption must not leave the test-mode WebView alive. This
    // route audit is explicitly cold/destructive; normal continuity runners
    // never invoke this cleanup path.
    terminateAuditApp();
  }
}

main();
