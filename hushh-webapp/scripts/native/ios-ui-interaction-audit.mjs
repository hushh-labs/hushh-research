#!/usr/bin/env node

import fs from "node:fs";
import { verifyPrebuiltNativeEnvironment, applyNativeAuditBuildEnvironment } from "./native-build-environment.mjs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import {
  defaultReviewerIdentityEnvFiles,
  resolveReviewerTestIdentity,
} from "../testing/reviewer-test-identity.mjs";
import { filterUiFlows } from "../testing/signed-in-ui-flows.mjs";
import { prepareNativeTestArtifacts } from "./prepare-native-test-artifacts.mjs";
import {
  advanceNativeUiCheckpoint,
  createNativeUiAuditPlan,
  hasTerminalNativeUiStatus,
  NATIVE_UI_TERMINAL_STATUS_GRACE_MS,
  nativeUiFlowStepTimeoutMs,
  validateNativeUiAuditCompletion,
} from "./native-ui-audit-plan.mjs";
import {
  assertNativeArtifactSafe,
  errorClass,
  sanitizeNativeArtifact,
  sanitizeStatusForReport,
} from "./native-report-sanitizer.mjs";

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
const requiredSimulatorDeviceId = "9C5B1D61-028C-474A-BDFC-523BACC3B02C";
const simulatorDevice = destinationDeviceId || "booted";
const bundleId = "com.hushh.app";
const timeoutMs = Number(process.env.IOS_UI_INTERACTION_TIMEOUT_MS || "600000");
const bootstrapTimeoutMs = Math.min(
  timeoutMs,
  Number(process.env.IOS_UI_INTERACTION_BOOT_TIMEOUT_MS || "45000")
);
const flowFilter = (process.env.IOS_UI_FLOW_FILTER || "").trim();
const routeFilter = (process.env.IOS_UI_ROUTE_FILTER || "").trim();
const xcodeProject = "ios/App/App.xcodeproj";
const xcodeScheme = "App";
// Isolates in-page flow checkpoints between audit launches without carrying
// user, vault, or route information into the identifier.
const uiFlowRunId = `ios-${Date.now().toString(36)}`;
let auditAppLaunched = false;

assertDestructiveNativeAuditAllowed();
if (destinationDeviceId !== requiredSimulatorDeviceId) {
  throw new Error(
    `native iOS UI interaction audit requires the configured iPhone 14 Plus (${requiredSimulatorDeviceId}).`,
  );
}

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir: repoRoot }),
});
const reviewerVaultPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;
const uiFlows = filterUiFlows({ flowFilter, routeFilter });
const auditPlan = createNativeUiAuditPlan(uiFlows);

function assertDestructiveNativeAuditAllowed() {
  if (process.env.HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT === "true") return;
  throw new Error(
    "This is a destructive cold-start audit: it terminates, uninstalls, and resets the iOS app before injecting the reviewer fixture. It cannot prove vault or route continuity. Use npm run ios:continuity:local for a normal-session check, or set HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT=true only for an intentional cold audit.",
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
  const copiedManifest = JSON.parse(fs.readFileSync(copiedManifestPath, "utf8"));
  if (copiedManifest?.audit_plan?.digest !== auditPlan.digest) {
    throw new Error("iOS bundle flow manifest does not match the requested audit plan.");
  }
  console.log(`==> native UI flow manifest copied (${manifest.flows.length} flow(s), plan ${auditPlan.digest.slice(0, 12)})`);
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

function verifyPrebuiltApp() {
  applyNativeAuditBuildEnvironment(repoRoot);
  verifyPrebuiltNativeEnvironment({ appPath, env: process.env });
  if (!fs.existsSync(appPath)) {
    throw new Error(`prebuilt iOS app is missing: ${appPath}`);
  }
  const bundledManifestPath = path.join(appPath, "public", "native-ui-flows.json");
  if (!fs.existsSync(bundledManifestPath)) {
    throw new Error("prebuilt iOS app has no native UI flow manifest.");
  }
  const bundledManifest = JSON.parse(fs.readFileSync(bundledManifestPath, "utf8"));
  if (bundledManifest?.audit_plan?.digest !== auditPlan.digest) {
    throw new Error(
      "prebuilt iOS app flow manifest does not match the requested audit plan.",
    );
  }
  console.log(
    `==> verified prebuilt iOS app (${uiFlows.length} flow(s), plan ${auditPlan.digest.slice(0, 12)})`,
  );
}

function ensureSimulatorBooted() {
  if (!destinationDeviceId) return;
  tryRun("xcrun", ["simctl", "boot", destinationDeviceId]);
  run("xcrun", ["simctl", "bootstatus", destinationDeviceId, "-b"]);
  if (process.env.NATIVE_AUDIT_VISIBLE === "true") {
    tryRun("open", ["-a", "Simulator"]);
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

function readUiReportFromContainer() {
  const container = run("xcrun", [
    "simctl",
    "get_app_container",
    simulatorDevice,
    bundleId,
    "data",
  ]);
  const reportFile = path.join(container, "Library", "Caches", "native-ui-interaction-report.json");
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
    "/login?redirect=%2Fone",
    "-UITestExpectedMarker",
    "native-route-one-home",
    "-UITestExpectedRoute",
    "/one",
    "-UITestAutoReviewerLogin",
    "true",
    "-UITestResetAppState",
    "true",
    "-UITestRunUiFlows",
    "true",
    "-UITestUiFlowRunId",
    uiFlowRunId,
  ];
  run("xcrun", args, {
    env: {
      ...process.env,
      SIMCTL_CHILD_HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE: reviewerVaultPassphrase,
      SIMCTL_CHILD_HUSHH_UI_TEST_REVIEWER_UID: reviewerUid,
    },
  });
  auditAppLaunched = true;
}

function terminateAuditApp() {
  if (!auditAppLaunched) return;
  auditAppLaunched = false;
  tryRun("xcrun", ["simctl", "terminate", simulatorDevice, bundleId]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    terminateAuditApp();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

function captureFailureScreenshot() {
  const screenshotDir = path.join(os.tmpdir(), "hushh-native-test-artifacts");
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, "native-ios-ui-interaction-failure.png");
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
  let lastProgressKey = "";
  let lastProgressAt = startedAt;
  let completedReport = null;
  let completedReportObservedAt = 0;
  const highestCheckpointByFlow = new Map();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const container = run("xcrun", [
        "simctl",
        "get_app_container",
        simulatorDevice,
        bundleId,
        "data",
      ]);
      const statusPath = path.join(container, "Library", "Caches", "native-test-status.txt");
      if (fs.existsSync(statusPath)) {
        const raw = fs.readFileSync(statusPath, "utf8").trim();
        lastStatus = parseStatus(raw);
        const checkpoint = advanceNativeUiCheckpoint({
          flows: uiFlows,
          status: lastStatus,
          highestByFlow: highestCheckpointByFlow,
        });
        if (!checkpoint.ok) {
          return {
            ok: false,
            report: readUiReportFromContainer(),
            status: lastStatus,
            error: `UI interaction audit ${checkpoint.reason}`,
          };
        }
        const progressKey = [
          lastStatus.ui_run || "",
          lastStatus.ui_flow || "",
          lastStatus.ui_step || "",
          lastStatus.ui_step_type || "",
          lastStatus.ui_checkpoint || "",
          lastStatus.route || "",
          lastStatus.bootstrap || "",
        ].join("|");
        if (progressKey && progressKey !== lastProgressKey) {
          process.stdout.write(
            `\n   → ${lastStatus.ui_flow || "bootstrap"} / ${lastStatus.ui_step_type || "waiting"} ... `,
          );
          lastProgressKey = progressKey;
          lastProgressAt = Date.now();
        }
        if (hasTerminalNativeUiStatus(lastStatus)) {
          const report = completedReport || readUiReportFromContainer();
          if (report) return { ok: Boolean(report.ok), report, status: lastStatus };
        }
        if (
          (lastStatus.runui || "") === "1" &&
          (lastStatus.uistarted || "") !== "1" &&
          (lastStatus.ui_complete || "") !== "1" &&
          Date.now() - startedAt >= bootstrapTimeoutMs
        ) {
          return {
            ok: false,
            status: lastStatus,
            error: "UI interaction audit bootstrap timed out",
          };
        }
        if ((lastStatus.uifailed || "") === "1") {
          return {
            ok: false,
            report: readUiReportFromContainer(),
            status: lastStatus,
            error: "UI interaction audit reported a terminal failure",
          };
        }
        if (
          (lastStatus.uistarted || "") === "1" &&
          (lastStatus.ui_complete || "") !== "1" &&
          Date.now() - lastProgressAt > nativeUiFlowStepTimeoutMs(uiFlows, lastStatus) + 10_000
        ) {
          return {
            ok: false,
            report: readUiReportFromContainer(),
            status: lastStatus,
            error: "UI interaction audit stalled without step progress",
          };
        }
      }

      const report = readUiReportFromContainer();
      if (report?.completedAt) {
        completedReport = report;
        completedReportObservedAt ||= Date.now();
        if (
          Date.now() - completedReportObservedAt >=
          NATIVE_UI_TERMINAL_STATUS_GRACE_MS
        ) {
          return {
            ok: false,
            report: completedReport,
            status: lastStatus,
            error:
              "iOS UI interaction report completed before native terminal status settled",
          };
        }
      }
    } catch {
      // App may still be booting.
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  const report = completedReport || readUiReportFromContainer();
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
  console.log(`==> audit plan: ${auditPlan.digest.slice(0, 12)}`);
  for (const flow of uiFlows) {
    console.log(`   • ${flow.id} — ${flow.description}`);
  }

  try {
    if (process.env.IOS_UI_INTERACTION_SKIP_BUILD === "true") {
      verifyPrebuiltApp();
    } else {
      buildApp();
    }

    ensureSimulatorBooted();
    launchUiInteractionAudit();
    const result = waitForUiInteractionReport();
    const completion = validateNativeUiAuditCompletion({
      report: result.report,
      status: result.status,
      plan: auditPlan,
      runId: uiFlowRunId,
    });
    const auditOk = Boolean(result.ok && completion.ok);
    const failureScreenshotPath = auditOk ? null : captureFailureScreenshot();
    const sanitizedReport = sanitizeNativeArtifact(result.report);
    const sanitizedErrorClass = errorClass(result.error || completion.reason);
    const skippedOptionalFlows = completion.ok
      ? completion.optionalSkippedFlowIds
      : [];
    const skippedConditionalRiaWorkspaceFlows = completion.ok
      ? completion.conditionalRiaWorkspaceSkippedFlowIds
      : [];
    const summary = {
      generated_at: new Date().toISOString(),
      destination,
      plan: {
        version: auditPlan.version,
        digest: auditPlan.digest,
        flow_count: auditPlan.flow_count,
      },
      flow_count: uiFlows.length,
      passed_flows:
        sanitizedReport?.flows?.filter((flow) => flow.ok && !flow.skipped).length ?? 0,
      failed_flows: sanitizedReport?.flows?.filter((flow) => !flow.ok).length ?? 0,
      skipped_optional_flows: skippedOptionalFlows,
      skipped_conditional_ria_workspace_flows:
        skippedConditionalRiaWorkspaceFlows,
      ok: auditOk,
      flows: uiFlows.map((flow) => flow.id),
      report: sanitizedReport,
      errorClass: sanitizedErrorClass || null,
      failure_screenshot: failureScreenshotPath ? "<external-test-artifact>" : null,
      last_status: sanitizeStatusForReport(result.status),
    };

    assertNativeArtifactSafe(summary, [reviewerUid, reviewerVaultPassphrase]);
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\n==> report: ${path.relative(repoRoot, reportPath)}`);

    if (summary.ok) {
      const optionalSuffix = skippedOptionalFlows.length
        ? `; ${skippedOptionalFlows.length} optional skipped`
        : "";
      const conditionalSuffix = skippedConditionalRiaWorkspaceFlows.length
        ? `; ${skippedConditionalRiaWorkspaceFlows.length} RIA-workspace conditional skipped`
        : "";
      console.log(`==> UI interactions passed (${summary.passed_flows}/${summary.flow_count}${optionalSuffix}${conditionalSuffix})`);
      return;
    }

    const failed = (sanitizedReport?.flows || []).filter((flow) => !flow.ok);
    for (const flow of failed) {
      console.log(`   ✗ ${flow.id}: ${flow.failedStep?.type || flow.results?.slice(-1)[0]?.errorClass || "failed"}`);
    }
    if (result.error) {
      console.log(`   ✗ ${sanitizedErrorClass || "other"}`);
    }
    if (!completion.ok) {
      console.log("   ✗ audit report did not prove the requested plan completed");
    }
    process.exitCode = 1;
  } finally {
    terminateAuditApp();
  }
}

main();
