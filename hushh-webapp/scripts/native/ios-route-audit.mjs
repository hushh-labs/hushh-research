#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const inventoryPath = path.join(repoRoot, "native-route-inventory.json");
const reportPath = path.join(repoRoot, "native-ios-parity-report.json");
const appPath =
  process.env.IOS_APP_PATH ||
  path.join(
    process.env.HOME || "",
    "Library/Developer/Xcode/DerivedData/App-gsttmaaoiypjtdgzrlnctebtjvgt/Build/Products/Debug-iphonesimulator/App.app"
  );
const destination = process.env.IOS_TEST_DESTINATION || "platform=iOS Simulator,name=iPhone 14 Plus";
const bundleId = "com.hushh.app";
const timeoutMs = Number(process.env.IOS_ROUTE_AUDIT_TIMEOUT_MS || "60000");
const routeFilter = (process.env.IOS_ROUTE_FILTER || "").trim();
const xcodeProject = "ios/App/App.xcodeproj";
const xcodeScheme = "App";

function sanitizeConfiguredValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  const lower = normalized.toLowerCase();
  if (
    lower.includes("replace_with") ||
    lower.includes("your_") ||
    lower === "placeholder"
  ) {
    return "";
  }
  return normalized;
}

function readRawEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith(`${key}=`)) {
      continue;
    }
    return line.slice(key.length + 1).trim();
  }
  return "";
}

function resolveKaiTestPassphrase() {
  const direct = sanitizeConfiguredValue(
    process.env.KAI_TEST_PASSPHRASE || process.env.NEXT_PUBLIC_KAI_TEST_PASSPHRASE || ""
  );
  if (direct) {
    return direct;
  }

  const envCandidates = [
    path.join(repoRoot, ".env.local.local"),
    path.join(repoRoot, "..", "consent-protocol", ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ];

  for (const candidate of envCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = dotenv.parse(fs.readFileSync(candidate, "utf8"));
    const value = sanitizeConfiguredValue(
      readRawEnvValue(candidate, "KAI_TEST_PASSPHRASE") ||
        parsed.KAI_TEST_PASSPHRASE ||
        parsed.NEXT_PUBLIC_KAI_TEST_PASSPHRASE ||
        ""
    );
    if (value) {
      return value;
    }
  }

  return "";
}

const kaiTestPassphrase = resolveKaiTestPassphrase();

function resolveReviewerUserId() {
  const direct = sanitizeConfiguredValue(
    process.env.REVIEWER_UID ||
    process.env.KAI_TEST_USER_ID ||
    process.env.NEXT_PUBLIC_KAI_TEST_USER_ID ||
    ""
  );
  if (direct) {
    return direct;
  }

  const envCandidates = [
    path.join(repoRoot, ".env.local.local"),
    path.join(repoRoot, "..", "consent-protocol", ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ];

  for (const candidate of envCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = dotenv.parse(fs.readFileSync(candidate, "utf8"));
    const value = sanitizeConfiguredValue(
      parsed.REVIEWER_UID || parsed.KAI_TEST_USER_ID || parsed.NEXT_PUBLIC_KAI_TEST_USER_ID || ""
    );
    if (value) {
      return value;
    }
  }

  return "";
}

const kaiTestUserId = resolveReviewerUserId();

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

function launchRoute(route) {
  tryRun("xcrun", ["simctl", "terminate", "booted", bundleId]);
  try {
    const container = run("xcrun", ["simctl", "get_app_container", "booted", bundleId, "data"]);
    const statusPath = path.join(container, "Documents", "native-test-status.txt");
    if (fs.existsSync(statusPath)) {
      fs.unlinkSync(statusPath);
    }
  } catch {
    // Best effort cleanup.
  }
  const args = ["simctl", "launch", "booted", bundleId, "-UITestMode", "-UITestInitialRoute", route.initialRoute];
  args.push("-UITestExpectedMarker", route.expectedMarker);
  if (route.expectedRoute) {
    args.push("-UITestExpectedRoute", route.expectedRoute);
  }
  args.push("-UITestAutoReviewerLogin", route.autoReviewerLogin ? "true" : "false");
  if (kaiTestPassphrase) {
    args.push("-UITestVaultPassphrase", kaiTestPassphrase);
  }
  if (kaiTestUserId) {
    args.push("-UITestExpectedUserId", kaiTestUserId);
  }
  run("xcrun", args);
}

function buildApp() {
  execSync("npm run cap:build", {
    cwd: repoRoot,
    stdio: "inherit",
  });
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

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const container = run("xcrun", ["simctl", "get_app_container", "booted", bundleId, "data"]);
      const statusPath = path.join(container, "Documents", "native-test-status.txt");
      if (fs.existsSync(statusPath)) {
        lastRaw = fs.readFileSync(statusPath, "utf8").trim();
        if (lastRaw) {
          lastParsed = parseStatus(lastRaw);
          const routeOk = matchesRoute(lastParsed.route || "", route);
          const authOk = (lastParsed.auth || "") === route.expectedAuth;
          const dataOk = route.allowedDataStates.includes(lastParsed.data || "");
          if (routeOk && authOk && dataOk) {
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

  buildApp();
  tryRun("xcrun", ["simctl", "terminate", "booted", bundleId]);
  tryRun("xcrun", ["simctl", "uninstall", "booted", bundleId]);
  run("xcrun", ["simctl", "install", "booted", appPath]);

  const results = [];

  for (const route of auditedRoutes) {
    process.stdout.write(`   - ${route.route} ... `);
    try {
      launchRoute(route);
      const result = waitForStatus(route);
      tryRun("xcrun", ["simctl", "terminate", "booted", bundleId]);

      if (!result.ok) {
        console.log("FAIL");
        results.push({
          route: route.route,
          ok: false,
          expected: route,
          observed: result.status,
          raw: result.raw,
        });
        continue;
      }

      console.log("OK");
      results.push({
        route: route.route,
        ok: true,
        expected: route,
        observed: result.status,
        raw: result.raw,
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
    audited_routes: auditedRoutes.length,
    passed_routes: results.filter((result) => result.ok).length,
    failed_routes: results.filter((result) => !result.ok).length,
    results,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`==> report: ${path.relative(repoRoot, reportPath)}`);

  if (summary.failed_routes > 0) {
    process.exit(1);
  }
}

main();
