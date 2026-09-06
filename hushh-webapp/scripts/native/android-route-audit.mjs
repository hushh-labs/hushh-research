#!/usr/bin/env node

import fs from "node:fs";
import { createAndroidCredentialRunId, deliverAndroidAuditCredentials } from "./android-audit-credentials.mjs";
import { applyNativeAuditBuildEnvironment } from "./native-build-environment.mjs";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import {
  defaultReviewerIdentityEnvFiles,
  resolveReviewerTestIdentity,
} from "../testing/reviewer-test-identity.mjs";
import { syncNativeFirebaseConfigs } from "./sync-native-firebase-configs.mjs";
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
const reportPath = path.join(repoRoot, "native-android-parity-report.json");
const androidDir = path.join(repoRoot, "android");
const defaultAndroidSdk = path.join(process.env.HOME || "", "Library/Android/sdk");
const defaultAdb = path.join(defaultAndroidSdk, "platform-tools/adb");
const defaultEmulator = path.join(defaultAndroidSdk, "emulator/emulator");
const adb = process.env.ADB || (fs.existsSync(defaultAdb) ? defaultAdb : "adb");
const emulatorBinary =
  process.env.ANDROID_EMULATOR ||
  (fs.existsSync(defaultEmulator) ? defaultEmulator : "emulator");
const bundleId = "com.hussh.app";
const activityName = `${bundleId}/.MainActivity`;
const apkPath =
  process.env.ANDROID_APK_PATH ||
  path.join(androidDir, "app/build/outputs/apk/debug/app-debug.apk");
const googleServicesCandidates = [
  path.join(androidDir, "app/google-services.json"),
  path.join(androidDir, "app/src/google-services.json"),
  path.join(androidDir, "app/src/debug/google-services.json"),
  path.join(androidDir, "app/src/Debug/google-services.json"),
];
const timeoutMs = Number(process.env.ANDROID_ROUTE_AUDIT_TIMEOUT_MS || "120000");
const noProgressTimeoutMs = Math.min(
  timeoutMs,
  Math.max(
    1_000,
    Number(process.env.ANDROID_ROUTE_AUDIT_NO_PROGRESS_TIMEOUT_MS || "20000"),
  ),
);
const maxConsecutiveFailures = Math.max(
  1,
  Number(process.env.ANDROID_ROUTE_AUDIT_MAX_CONSECUTIVE_FAILURES || "3"),
);
const emulatorBootTimeoutMs = Number(
  process.env.ANDROID_EMULATOR_BOOT_TIMEOUT_MS || "180000"
);
const routeFilter = (process.env.ANDROID_ROUTE_FILTER || "").trim();
const clearAppDataBetweenRoutes =
  process.env.ANDROID_ROUTE_AUDIT_CLEAR_APP_DATA_BETWEEN_ROUTES === "true";
const reinstallBetweenRoutes =
  process.env.ANDROID_ROUTE_AUDIT_REINSTALL_BETWEEN_ROUTES === "true";
const reinstallRouteSet = new Set(
  (
    process.env.ANDROID_ROUTE_AUDIT_REINSTALL_ROUTES ||
    "/register-phone,/logout,/login"
  )
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
);
let activeAuditSerial = "";
let startedEmulator = false;
let startedEmulatorSerial = "";

assertDestructiveNativeAuditAllowed();

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir }),
});
const reviewerVaultPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;

function assertDestructiveNativeAuditAllowed() {
  if (process.env.HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT === "true") return;
  throw new Error(
    "This is a destructive cold-start route audit: it force-stops and can clear or reinstall the Android app. It cannot prove vault or route continuity. Use npm run android:continuity:local for a normal-session check, or set HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT=true only for an intentional cold audit.",
  );
}

function run(cmd, args, options = {}) {
  const output = execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function runAndroid(cmd, args, options = {}) {
  const output = execFileSync(cmd, args, {
    cwd: androidDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function tryRun(cmd, args, options = {}) {
  try {
    return run(cmd, args, options);
  } catch {
    return "";
  }
}

function adbArgs(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

function runAdb(serial, args, options = {}) {
  return run(adb, adbArgs(serial, args), options);
}

function tryRunAdb(serial, args, options = {}) {
  try {
    return runAdb(serial, args, options);
  } catch {
    return "";
  }
}

function cleanupAuditProcess() {
  const serial = activeAuditSerial;
  if (serial) {
    tryRunAdb(serial, ["shell", "am", "force-stop", bundleId], {
      stdio: "ignore",
    });
  }
  activeAuditSerial = "";
  if (serial && startedEmulatorSerial === serial) {
    tryRunAdb(serial, ["emu", "kill"], { stdio: "ignore" });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupAuditProcess();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listReadyAdbDevices() {
  const output = run(adb, ["devices"]);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

function discoverAvdName() {
  const requested = (process.env.ANDROID_AVD_NAME || "").trim();
  if (requested) {
    return requested;
  }

  const avdDir = path.join(process.env.HOME || "", ".android/avd");
  if (!fs.existsSync(avdDir)) {
    return "";
  }
  const entry = fs
    .readdirSync(avdDir)
    .find((candidate) => candidate.endsWith(".avd"));
  return entry ? entry.replace(/\.avd$/, "") : "";
}

function bootEmulatorIfNeeded() {
  const avdName = discoverAvdName();
  if (!avdName) {
    throw new Error(
      "No booted Android emulator/device found and no AVD is available. Start an emulator or set ANDROID_AVD_NAME."
    );
  }

  const extraArgs = (process.env.ANDROID_EMULATOR_ARGS || "-no-snapshot-save")
    .split(/\s+/)
    .filter(Boolean);
  console.log(`==> booting Android emulator: ${avdName}`);
  const displayArgs = process.env.NATIVE_AUDIT_VISIBLE === "true" ? [] : ["-no-window", "-no-audio"];
  const child = spawn(emulatorBinary, ["-avd", avdName, ...extraArgs, ...displayArgs], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  startedEmulator = true;
}

function waitForBootedDevice() {
  const startedAt = Date.now();
  let lastSerial = "";

  while (Date.now() - startedAt < emulatorBootTimeoutMs) {
    const devices = listReadyAdbDevices();
    if (devices.length > 0) {
      lastSerial = devices[0];
      const bootCompleted = tryRunAdb(lastSerial, [
        "shell",
        "getprop",
        "sys.boot_completed",
      ]);
      if (bootCompleted.trim() === "1") {
        return lastSerial;
      }
    }
    sleep(2000);
  }

  throw new Error(
    `Android emulator did not become boot-ready within ${emulatorBootTimeoutMs}ms${
      lastSerial ? ` (last device: ${lastSerial})` : ""
    }.`
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

function resolveAdbDevice() {
  const requested =
    (process.env.ANDROID_SERIAL || process.env.ANDROID_DEVICE_ID || "").trim();
  if (requested) {
    const state = runAdb(requested, ["get-state"]);
    if (state !== "device") {
      throw new Error(
        `Android device ${requested} is not ready (adb state: ${state || "unknown"}).`
      );
    }
    return requested;
  }

  let devices = listReadyAdbDevices();

  if (devices.length === 0) {
    bootEmulatorIfNeeded();
    const serial = waitForBootedDevice();
    if (startedEmulator) {
      startedEmulatorSerial = serial;
    }
    devices = [serial];
  }
  return devices[0];
}

function ensureNativeTestBuildEnv() {
  applyNativeAuditBuildEnvironment(repoRoot);
}

function buildApp() {
  ensureNativeTestBuildEnv();
  syncNativeFirebaseConfigs({ appRoot: repoRoot, monorepoRoot });

  if (!googleServicesCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(
      "Missing Android Firebase artifact. Add the untracked android/app/google-services.json (or a debug source-set equivalent) before running android:test."
    );
  }

  execSync("npm run cap:build", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  execSync("npm run cap:sync:android", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  runAndroid("./gradlew", [":app:assembleDebug"], {
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 20,
  });
}

function clearStatus(serial, options = {}) {
  tryRunAdb(serial, ["shell", "am", "force-stop", bundleId], { stdio: "ignore" });
  if (options.clearAppData) {
    tryRunAdb(serial, ["shell", "pm", "clear", bundleId], { stdio: "ignore" });
  }
  tryRunAdb(serial, ["shell", "run-as", bundleId, "rm", "files/native-test-status.txt"], {
    stdio: "ignore",
  });
}

function installApk(serial) {
  runAdb(serial, ["install", "-r", "-t", apkPath], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 10,
  });
}

function reinstallApp(serial) {
  tryRunAdb(serial, ["uninstall", bundleId], { stdio: "ignore" });
  installApk(serial);
}

function launchRoute(serial, route) {
  const credentialRunId = createAndroidCredentialRunId();
  const shouldReinstallForRoute =
    reinstallBetweenRoutes || reinstallRouteSet.has(route.route);
  clearStatus(serial, {
    clearAppData: clearAppDataBetweenRoutes && !shouldReinstallForRoute,
  });
  if (shouldReinstallForRoute) {
    reinstallApp(serial);
  }
  const args = [
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    activityName,
    "--ez",
    "HUSHH_NATIVE_TEST_MODE",
    "true",
    "--es",
    "HUSHH_NATIVE_TEST_INITIAL_ROUTE",
    route.initialRoute,
    "--es",
    "HUSHH_NATIVE_TEST_EXPECTED_MARKER",
    route.expectedMarker,
    "--ez",
    "HUSHH_NATIVE_TEST_AUTO_REVIEWER_LOGIN",
    route.autoReviewerLogin ? "true" : "false",
    "--es",
    "HUSHH_NATIVE_TEST_CREDENTIAL_RUN_ID",
    credentialRunId,
  ];

  if (route.expectedRoute) {
    args.push("--es", "HUSHH_NATIVE_TEST_EXPECTED_ROUTE", route.expectedRoute);
  }

  runAdb(serial, args);
  deliverAndroidAuditCredentials({ adb, serial, runId: credentialRunId, reviewerUid, reviewerVaultPassphrase });
}

function readStatus(serial) {
  return runAdb(serial, [
    "exec-out",
    "run-as",
    bundleId,
    "cat",
    "files/native-test-status.txt",
  ]);
}

function waitForStatus(serial, route) {
  const startedAt = Date.now();
  let lastRaw = "";
  let lastParsed = {};
  let lastProgressKey = "";
  let lastProgressAt = startedAt;
  let settledMismatchKey = "";
  let settledMismatchAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const rawStatus = readStatus(serial).trim();
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
        const foundOk = (lastParsed.found || "") === "1";
        const markerOk = (lastParsed.marker || "") === route.expectedMarker;
        const routeOk = matchesRoute(lastParsed.route || "", route);
        const authOk = (lastParsed.auth || "") === route.expectedAuth;
        const dataOk = route.allowedDataStates.includes(lastParsed.data || "");
        if (readyOk && foundOk && markerOk && routeOk && authOk && dataOk) {
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
    } catch {
      // The app may still be booting or the debug package may not have created the file.
    }

    if (Date.now() - lastProgressAt >= noProgressTimeoutMs) {
      return {
        ok: false,
        status: lastParsed,
        raw: lastRaw,
        errorClass: "stalled",
      };
    }

    sleep(1000);
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

  console.log(`==> native Android route audit (${auditedRoutes.length} routes)`);
  console.log(`==> failure circuit breaker: ${maxConsecutiveFailures} consecutive route failures`);
  fs.rmSync(reportPath, { force: true });

  buildApp();
  const serial = resolveAdbDevice();
  activeAuditSerial = serial;
  console.log(`==> device: ${serial}`);

  if (!fs.existsSync(apkPath)) {
    throw new Error(`Debug APK not found at ${path.relative(repoRoot, apkPath)}.`);
  }

  reinstallApp(serial);

  const results = [];
  let consecutiveFailures = 0;
  let auditComplete = true;

  for (const route of auditedRoutes) {
    process.stdout.write(`   - ${route.route} ... `);
    try {
      launchRoute(serial, route);
      const result = waitForStatus(serial, route);
      clearStatus(serial);

      if (!result.ok) {
        console.log("FAIL");
        results.push({
          route: route.route,
          ok: false,
          expected: route,
          observed: sanitizeStatusForReport(result.status),
          raw: sanitizeRawStatusForReport(result.raw),
          errorClass: result.errorClass || undefined,
        });
        consecutiveFailures += 1;
      } else {
        console.log("OK");
        results.push({
          route: route.route,
          ok: true,
          expected: route,
          observed: sanitizeStatusForReport(result.status),
          raw: sanitizeRawStatusForReport(result.raw),
        });
        consecutiveFailures = 0;
      }
    } catch (error) {
      console.log("FAIL");
      clearStatus(serial);
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
      console.log(`==> stopping after ${consecutiveFailures} consecutive route failures`);
      break;
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    device: serial,
    audited_routes: auditedRoutes.length,
    completed_routes: results.length,
    audit_complete: auditComplete && results.length === auditedRoutes.length,
    max_consecutive_failures: maxConsecutiveFailures,
    passed_routes: results.filter((result) => result.ok).length,
    failed_routes: results.filter((result) => !result.ok).length,
    results,
  };

  const sanitizedSummary = sanitizeNativeArtifact(summary);
  assertNativeArtifactSafe(sanitizedSummary, [reviewerUid, reviewerVaultPassphrase]);
  fs.writeFileSync(reportPath, `${JSON.stringify(sanitizedSummary, null, 2)}\n`);
  console.log(`==> report: ${path.relative(repoRoot, reportPath)}`);

  if (!summary.audit_complete || summary.failed_routes > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanupAuditProcess();
}
