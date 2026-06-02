#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import {
  defaultReviewerIdentityEnvFiles,
  parseEnvFile,
  resolveReviewerTestIdentity,
} from "../testing/reviewer-test-identity.mjs";
import { filterUiFlows } from "../testing/signed-in-ui-flows.mjs";
import { prepareNativeTestArtifacts } from "./prepare-native-test-artifacts.mjs";
import { syncNativeFirebaseConfigs } from "./sync-native-firebase-configs.mjs";

const repoRoot = process.cwd();
const webDir = repoRoot;
const monorepoRoot = path.resolve(webDir, "..");
const androidDir = path.join(repoRoot, "android");
const reportPath = path.join(repoRoot, "native-android-ui-interaction-report.json");
const defaultAndroidSdk = path.join(process.env.HOME || "", "Library/Android/sdk");
const defaultAdb = path.join(defaultAndroidSdk, "platform-tools/adb");
const adb = process.env.ADB || (fs.existsSync(defaultAdb) ? defaultAdb : "adb");
const bundleId = "com.hushh.app";
const activityName = "com.hushh.app/.MainActivity";
const apkPath =
  process.env.ANDROID_APK_PATH ||
  path.join(androidDir, "app/build/outputs/apk/debug/app-debug.apk");
const timeoutMs = Number(process.env.ANDROID_UI_INTERACTION_TIMEOUT_MS || "600000");
const flowFilter = (process.env.ANDROID_UI_FLOW_FILTER || "").trim();
const routeFilter = (process.env.ANDROID_UI_ROUTE_FILTER || "").trim();
const googleServicesCandidates = [
  path.join(androidDir, "app/google-services.json"),
  path.join(androidDir, "app/src/google-services.json"),
  path.join(androidDir, "app/src/debug/google-services.json"),
  path.join(androidDir, "app/src/Debug/google-services.json"),
];

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir }),
});
const reviewerVaultPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;
const uiFlows = filterUiFlows({ flowFilter, routeFilter });
const REDACTED_REPORT_STATUS_KEYS = new Set([
  "bootstrap_uid",
  "body",
  "bodySnippet",
  "jserr",
]);

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

  const devices = listReadyAdbDevices();
  if (devices.length === 0) {
    throw new Error(
      "No connected Android device is ready. Connect one with USB debugging enabled or set ANDROID_SERIAL."
    );
  }
  return devices[0];
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

function sanitizeStatusForReport(status = {}) {
  return Object.fromEntries(
    Object.entries(status || {}).map(([key, value]) => [
      key,
      REDACTED_REPORT_STATUS_KEYS.has(key) && value ? "<redacted>" : value,
    ])
  );
}

function applyEnvValues(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      process.env[key] = value;
    }
  }
}

function ensureNativeTestBuildEnv() {
  const uatEnvPath = path.join(repoRoot, ".env.uat.local");
  const uatValues = parseEnvFile(uatEnvPath);
  const configured = String(process.env.NEXT_PUBLIC_BACKEND_URL || "").trim();
  const backendUrl =
    configured && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(configured)
      ? configured
      : String(uatValues.NEXT_PUBLIC_BACKEND_URL || "").trim();

  if (!backendUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(backendUrl)) {
    throw new Error(
      "native Android UI interaction audit requires UAT NEXT_PUBLIC_BACKEND_URL (.env.uat.local)."
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
  syncNativeFirebaseConfigs({ appRoot: repoRoot, monorepoRoot });

  if (!googleServicesCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(
      "Missing Android Firebase artifact. Add android/app/google-services.json or a debug source-set equivalent before running android:ui:test."
    );
  }

  execSync("npm run cap:build", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  const manifest = prepareNativeTestArtifacts({ flowFilter, routeFilter });
  execSync("npm run cap:sync:android", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  const copiedManifestPath = path.join(
    repoRoot,
    "android/app/src/main/assets/public/native-ui-flows.json"
  );
  const copiedRunnerPath = path.join(
    repoRoot,
    "android/app/src/main/assets/public/native-ui-test-runner.js"
  );
  if (!fs.existsSync(copiedManifestPath)) {
    throw new Error("native-ui-flows.json was not copied into the Android app bundle.");
  }
  if (!fs.existsSync(copiedRunnerPath)) {
    throw new Error("native-ui-test-runner.js was not copied into the Android app bundle.");
  }
  console.log(`==> native UI flow manifest copied (${manifest.flows.length} flow(s))`);
  runAndroid("./gradlew", [":app:assembleDebug"], {
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 20,
  });
}

function installAndLaunch(serial) {
  const launchTarget = resolveInitialLaunchTarget();
  const encodedRedirect = encodeURIComponent(launchTarget.route);
  tryRunAdb(serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    stdio: "ignore",
  });
  tryRunAdb(serial, ["shell", "wm", "dismiss-keyguard"], { stdio: "ignore" });
  tryRunAdb(serial, ["shell", "input", "keyevent", "KEYCODE_MENU"], { stdio: "ignore" });
  tryRunAdb(serial, ["shell", "am", "force-stop", bundleId], { stdio: "ignore" });
  tryRunAdb(serial, ["uninstall", bundleId], { stdio: "ignore" });
  runAdb(serial, ["install", "-r", "-t", apkPath], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 10,
  });
  tryRunAdb(serial, ["shell", "pm", "clear", bundleId], { stdio: "ignore" });
  tryRunAdb(serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    stdio: "ignore",
  });
  tryRunAdb(serial, ["shell", "wm", "dismiss-keyguard"], { stdio: "ignore" });

  runAdb(serial, [
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
    `/login?redirect=${encodedRedirect}`,
    "--es",
    "HUSHH_NATIVE_TEST_EXPECTED_MARKER",
    launchTarget.marker,
    "--es",
    "HUSHH_NATIVE_TEST_EXPECTED_ROUTE",
    launchTarget.route,
    "--ez",
    "HUSHH_NATIVE_TEST_AUTO_REVIEWER_LOGIN",
    "true",
    "--ez",
    "HUSHH_NATIVE_TEST_RESET_APP_STATE",
    "true",
    "--ez",
    "HUSHH_NATIVE_TEST_RUN_UI_FLOWS",
    "true",
    "--es",
    "HUSHH_NATIVE_TEST_VAULT_PASSPHRASE",
    reviewerVaultPassphrase,
    "--es",
    "HUSHH_NATIVE_TEST_EXPECTED_USER_ID",
    reviewerUid,
  ]);
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

function resolveInitialLaunchTarget() {
  const firstFlow = uiFlows[0];
  const firstEnsurePersona = firstFlow?.steps?.find(
    (step) => step?.type === "ensure_persona" && step?.persona
  )?.persona;
  const firstRoute = String(firstFlow?.route || "");
  const route =
    firstEnsurePersona === "investor"
      ? "/kai"
      : firstEnsurePersona === "ria"
        ? "/ria"
        : firstRoute.startsWith("/kai")
          ? "/kai"
          : firstRoute.startsWith("/ria")
            ? "/ria"
            : "/ria";

  return {
    route,
    marker: route === "/kai" ? "native-route-kai-home" : "native-route-ria-home",
  };
}

function readUiReport(serial) {
  const raw = tryRunAdb(serial, [
    "exec-out",
    "run-as",
    bundleId,
    "cat",
    "files/native-ui-interaction-report.json",
  ]);
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function waitForUiInteractionReport(serial) {
  const startedAt = Date.now();
  let lastStatus = {};
  let lastFlow = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = readStatus(serial).trim();
      if (raw) {
        lastStatus = parseStatus(raw);
        const currentFlow = lastStatus.ui_flow || "";
        if (currentFlow && currentFlow !== lastFlow) {
          process.stdout.write(`\n   -> flow ${currentFlow} ... `);
          lastFlow = currentFlow;
        }
        if ((lastStatus.ui_complete || "") === "1") {
          const report = readUiReport(serial);
          if (report) return { ok: Boolean(report.ok), report, status: lastStatus };
        }
      }

      const report = readUiReport(serial);
      if (report?.completedAt) {
        return { ok: Boolean(report.ok), report, status: lastStatus };
      }
    } catch {
      // App may still be booting or the debug package may not have created files.
    }

    sleep(1000);
  }

  const report = readUiReport(serial);
  return {
    ok: false,
    report,
    status: lastStatus,
    error: "Android UI interaction audit timed out",
  };
}

function main() {
  if (uiFlows.length === 0) {
    throw new Error("No UI flows matched the current filter.");
  }

  console.log(`==> native Android UI interaction audit (${uiFlows.length} flows)`);
  for (const flow of uiFlows) {
    console.log(`   - ${flow.id} — ${flow.description}`);
  }

  if (process.env.ANDROID_UI_INTERACTION_SKIP_BUILD !== "true") {
    buildApp();
  } else {
    console.log("==> skipping rebuild (ANDROID_UI_INTERACTION_SKIP_BUILD=true)");
    prepareNativeTestArtifacts({ flowFilter, routeFilter });
  }

  const serial = resolveAdbDevice();
  console.log(`==> device: ${serial}`);
  installAndLaunch(serial);
  const result = waitForUiInteractionReport(serial);
  tryRunAdb(serial, ["shell", "am", "force-stop", bundleId], { stdio: "ignore" });

  const summary = {
    generated_at: new Date().toISOString(),
    device: serial,
    flow_count: uiFlows.length,
    passed_flows: result.report?.flows?.filter((flow) => flow.ok).length ?? 0,
    failed_flows: result.report?.flows?.filter((flow) => !flow.ok).length ?? 0,
    ok: Boolean(result.ok && result.report?.ok),
    flows: uiFlows.map((flow) => flow.id),
    report: result.report,
    error: result.error || null,
    last_status: sanitizeStatusForReport(result.status),
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n==> report: ${path.relative(repoRoot, reportPath)}`);

  if (summary.ok) {
    console.log(`==> Android UI interactions passed (${summary.passed_flows}/${summary.flow_count})`);
    return;
  }

  const failed = (result.report?.flows || []).filter((flow) => !flow.ok);
  for (const flow of failed) {
    console.log(
      `   x ${flow.id}: ${flow.failedStep?.type || flow.results?.slice(-1)[0]?.error || "failed"}`
    );
  }
  if (result.error) {
    console.log(`   x ${result.error}`);
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
