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

const repoRoot = process.cwd();
const monorepoRoot = path.resolve(repoRoot, "..");
const reportPath = path.join(repoRoot, "native-ios-ui-interaction-report.json");
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
const timeoutMs = Number(process.env.IOS_UI_INTERACTION_TIMEOUT_MS || "600000");
const flowFilter = (process.env.IOS_UI_FLOW_FILTER || "").trim();
const routeFilter = (process.env.IOS_UI_ROUTE_FILTER || "").trim();
const xcodeProject = "ios/App/App.xcodeproj";
const xcodeScheme = "App";
const keepAppAfterAudit = process.env.IOS_UI_INTERACTION_KEEP_APP === "true";

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir: repoRoot }),
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
    // Fall through.
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
    // Best effort.
  }
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
      "native iOS UI interaction audit requires UAT NEXT_PUBLIC_BACKEND_URL (.env.uat.local)."
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
  const manifest = prepareNativeTestArtifacts({ flowFilter, routeFilter });
  execSync("npm run cap:sync:ios", {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  const copiedManifestPath = path.join(repoRoot, "ios/App/App/public/native-ui-flows.json");
  if (!fs.existsSync(copiedManifestPath)) {
    throw new Error("native-ui-flows.json was not copied into the iOS app bundle.");
  }
  console.log(`==> native UI flow manifest copied (${manifest.flows.length} flow(s))`);
  run(
    "xcodebuild",
    [
      "-project",
      xcodeProject,
      "-scheme",
      xcodeScheme,
      "-destination",
      destination,
      "-derivedDataPath",
      derivedDataPath,
      "build",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 20,
    }
  );
}

function ensureSimulatorBooted() {
  if (!destinationDeviceId) return;
  tryRun("xcrun", ["simctl", "boot", destinationDeviceId]);
  run("xcrun", ["simctl", "bootstatus", destinationDeviceId, "-b"]);
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

function readUiReportFromContainer() {
  const container = run("xcrun", [
    "simctl",
    "get_app_container",
    simulatorDevice,
    bundleId,
    "data",
  ]);
  const reportFile = path.join(container, "Documents", "native-ui-interaction-report.json");
  if (!fs.existsSync(reportFile)) return null;
  return JSON.parse(fs.readFileSync(reportFile, "utf8"));
}

function launchUiInteractionAudit() {
  tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
  tryRun("xcrun", ["simctl", "uninstall", simulatorDevice, bundleId]);
  run("xcrun", ["simctl", "install", simulatorDevice, appPath]);

  const args = [
    "simctl",
    "launch",
    simulatorDevice,
    bundleId,
    "-UITestMode",
    "-UITestInitialRoute",
    "/login?redirect=%2Fria",
    "-UITestExpectedMarker",
    "native-route-ria-home",
    "-UITestExpectedRoute",
    "/ria",
    "-UITestAutoReviewerLogin",
    "true",
    "-UITestResetAppState",
    "true",
    "-UITestRunUiFlows",
    "true",
    "-UITestVaultPassphrase",
    reviewerVaultPassphrase,
    "-UITestExpectedUserId",
    reviewerUid,
  ];
  run("xcrun", args);
}

function captureFailureScreenshot() {
  const screenshotPath = path.join(repoRoot, "native-ios-ui-interaction-failure.png");
  tryRun("xcrun", [
    "simctl",
    "io",
    simulatorDevice,
    "screenshot",
    screenshotPath,
  ]);
  return screenshotPath;
}

function waitForUiInteractionReport() {
  const startedAt = Date.now();
  let lastStatus = {};
  let lastFlow = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const container = run("xcrun", [
        "simctl",
        "get_app_container",
        simulatorDevice,
        bundleId,
        "data",
      ]);
      const statusPath = path.join(container, "Documents", "native-test-status.txt");
      if (fs.existsSync(statusPath)) {
        const raw = fs.readFileSync(statusPath, "utf8").trim();
        lastStatus = parseStatus(raw);
        const currentFlow = lastStatus.ui_flow || "";
        if (currentFlow && currentFlow !== lastFlow) {
          process.stdout.write(`\n   → flow ${currentFlow} ... `);
          lastFlow = currentFlow;
        }
        if ((lastStatus.ui_complete || "") === "1") {
          const report = readUiReportFromContainer();
          if (report) return { ok: true, report, status: lastStatus };
        }
        if ((lastStatus.ui_complete || "") === "0" && lastStatus.error) {
          // keep waiting unless explicit failure in report
        }
      }

      const report = readUiReportFromContainer();
      if (report?.completedAt) {
        return { ok: Boolean(report.ok), report, status: lastStatus };
      }
    } catch {
      // App may still be booting.
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  const report = readUiReportFromContainer();
  return {
    ok: false,
    report,
    status: lastStatus,
    error: "UI interaction audit timed out",
  };
}

function main() {
  if (uiFlows.length === 0) {
    throw new Error("No UI flows matched the current filter.");
  }

  console.log(`==> native iOS UI interaction audit (${uiFlows.length} flows)`);
  console.log(`==> destination: ${destination}`);
  for (const flow of uiFlows) {
    console.log(`   • ${flow.id} — ${flow.description}`);
  }

  if (process.env.IOS_UI_INTERACTION_SKIP_BUILD !== "true") {
    buildApp();
  } else {
    console.log("==> skipping rebuild (IOS_UI_INTERACTION_SKIP_BUILD=true)");
    prepareNativeTestArtifacts({ flowFilter, routeFilter });
  }

  ensureSimulatorBooted();
  launchUiInteractionAudit();
  const result = waitForUiInteractionReport();
  const auditOk = Boolean(result.ok && result.report?.ok);
  const failureScreenshotPath = auditOk ? null : captureFailureScreenshot();
  if (!keepAppAfterAudit) {
    tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    destination,
    flow_count: uiFlows.length,
    passed_flows: result.report?.flows?.filter((flow) => flow.ok).length ?? 0,
    failed_flows: result.report?.flows?.filter((flow) => !flow.ok).length ?? 0,
    ok: auditOk,
    flows: uiFlows.map((flow) => flow.id),
    report: result.report,
    error: result.error || null,
    failure_screenshot: failureScreenshotPath,
    last_status: sanitizeStatusForReport(result.status),
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n==> report: ${path.relative(repoRoot, reportPath)}`);

  if (summary.ok) {
    console.log(`==> UI interactions passed (${summary.passed_flows}/${summary.flow_count})`);
    return;
  }

  const failed = (result.report?.flows || []).filter((flow) => !flow.ok);
  for (const flow of failed) {
    console.log(`   ✗ ${flow.id}: ${flow.failedStep?.type || flow.results?.slice(-1)[0]?.error || "failed"}`);
  }
  if (result.error) {
    console.log(`   ✗ ${result.error}`);
  }
  process.exit(1);
}

main();
