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
import { syncNativeFirebaseConfigs } from "./sync-native-firebase-configs.mjs";
import {
  assertNativeArtifactSafe,
  errorClass,
  sanitizeNativeArtifact,
  sanitizeStatusForReport,
} from "./native-report-sanitizer.mjs";

const repoRoot = process.cwd();
const webDir = repoRoot;
const monorepoRoot = path.resolve(webDir, "..");
const androidDir = path.join(repoRoot, "android");
const reportPath = path.join(
  repoRoot,
  "native-android-ui-interaction-report.json",
);
const defaultAndroidSdk = path.join(
  process.env.HOME || "",
  "Library/Android/sdk",
);
const defaultAdb = path.join(defaultAndroidSdk, "platform-tools/adb");
const defaultEmulator = path.join(defaultAndroidSdk, "emulator/emulator");
const adb = process.env.ADB || (fs.existsSync(defaultAdb) ? defaultAdb : "adb");
const emulator =
  process.env.ANDROID_EMULATOR ||
  (fs.existsSync(defaultEmulator) ? defaultEmulator : "emulator");
const bundleId = "com.hussh.app";
const activityName = "com.hussh.app/.MainActivity";
const apkPath =
  process.env.ANDROID_APK_PATH ||
  path.join(androidDir, "app/build/outputs/apk/debug/app-debug.apk");
const timeoutMs = Number(
  process.env.ANDROID_UI_INTERACTION_TIMEOUT_MS || "600000",
);
const flowFilter = (process.env.ANDROID_UI_FLOW_FILTER || "").trim();
const routeFilter = (process.env.ANDROID_UI_ROUTE_FILTER || "").trim();
let startedEmulatorSerial = "";
// Isolates in-page flow checkpoints between cold audit launches without
// carrying reviewer, vault, route, or content data in the identifier.
const uiFlowRunId = `android-${Date.now().toString(36)}`;
let activeAuditSerial = "";
const googleServicesCandidates = [
  path.join(androidDir, "app/google-services.json"),
  path.join(androidDir, "app/src/google-services.json"),
  path.join(androidDir, "app/src/debug/google-services.json"),
  path.join(androidDir, "app/src/Debug/google-services.json"),
];

assertDestructiveNativeAuditAllowed();

const reviewerIdentity = resolveReviewerTestIdentity({
  envFiles: defaultReviewerIdentityEnvFiles({ repoRoot: monorepoRoot, webDir }),
});
const reviewerVaultPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const reviewerUid = reviewerIdentity.reviewerUid;
const uiFlows = filterUiFlows({ flowFilter, routeFilter });
const auditPlan = createNativeUiAuditPlan(uiFlows);

function assertDestructiveNativeAuditAllowed() {
  if (process.env.HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT === "true") return;
  throw new Error(
    "This is a destructive cold-start audit: it force-stops, uninstalls, clears, and resets the Android app before injecting the reviewer fixture. It cannot prove vault or route continuity. Use npm run android:continuity:local for a normal-session check, or set HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT=true only for an intentional cold audit.",
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

function stopAuditApp() {
  if (!activeAuditSerial) return;
  tryRunAdb(activeAuditSerial, ["shell", "am", "force-stop", bundleId], {
    stdio: "ignore",
  });
}

function cleanupAuditProcess() {
  const serial = activeAuditSerial;
  stopAuditApp();
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

function listAndroidAvds() {
  const output = tryRun(emulator, ["-list-avds"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function waitForBootedDevice(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const devices = listReadyAdbDevices();
    if (devices.length > 0) {
      const serial = devices[0];
      const booted = tryRunAdb(serial, [
        "shell",
        "getprop",
        "sys.boot_completed",
      ]);
      if (booted.trim() === "1") {
        tryRunAdb(serial, ["shell", "input", "keyevent", "82"], {
          stdio: "ignore",
        });
        return serial;
      }
    }
    sleep(1000);
  }
  throw new Error("Android emulator did not finish booting before timeout.");
}

function bootAndroidEmulator() {
  if (
    String(process.env.ANDROID_AUTO_BOOT_AVD || "true").toLowerCase() ===
    "false"
  ) {
    throw new Error(
      "No connected Android device is ready. Connect one with USB debugging enabled, set ANDROID_SERIAL, or enable ANDROID_AUTO_BOOT_AVD.",
    );
  }

  const avds = listAndroidAvds();
  const requestedAvd = (process.env.ANDROID_AVD_NAME || "").trim();
  const avdName = requestedAvd || avds[0] || "";
  if (!avdName) {
    throw new Error(
      "No connected Android device is ready and no Android AVD is available to boot.",
    );
  }

  const extraArgs = String(process.env.ANDROID_EMULATOR_ARGS || "")
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
  const args = [
    "-avd",
    avdName,
    "-no-snapshot-load",
    "-no-audio",
    ...extraArgs,
    ...(process.env.NATIVE_AUDIT_VISIBLE === "true" ? [] : ["-no-window"]),
  ];
  console.log(`==> booting Android emulator: ${avdName}`);
  const child = spawn(emulator, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  startedEmulatorSerial = waitForBootedDevice();
  return startedEmulatorSerial;
}

function resolveAdbDevice() {
  const requested = (
    process.env.ANDROID_SERIAL ||
    process.env.ANDROID_DEVICE_ID ||
    ""
  ).trim();
  if (requested) {
    const state = runAdb(requested, ["get-state"]);
    if (state !== "device") {
      throw new Error(
        `Android device ${requested} is not ready (adb state: ${state || "unknown"}).`,
      );
    }
    return requested;
  }

  const devices = listReadyAdbDevices();
  if (devices.length === 0) {
    return bootAndroidEmulator();
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
      }),
  );
}

function ensureNativeTestBuildEnv() {
  applyNativeAuditBuildEnvironment(repoRoot);
}

function buildApp() {
  ensureNativeTestBuildEnv();
  syncNativeFirebaseConfigs({ appRoot: repoRoot, monorepoRoot });

  if (!googleServicesCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(
      "Missing Android Firebase artifact. Add android/app/google-services.json or a debug source-set equivalent before running android:ui:test.",
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
    "android/app/src/main/assets/public/native-ui-flows.json",
  );
  const copiedRunnerPath = path.join(
    repoRoot,
    "android/app/src/main/assets/public/native-ui-test-runner.js",
  );
  if (!fs.existsSync(copiedManifestPath)) {
    throw new Error(
      "native-ui-flows.json was not copied into the Android app bundle.",
    );
  }
  if (!fs.existsSync(copiedRunnerPath)) {
    throw new Error(
      "native-ui-test-runner.js was not copied into the Android app bundle.",
    );
  }
  const copiedManifest = JSON.parse(fs.readFileSync(copiedManifestPath, "utf8"));
  if (copiedManifest?.audit_plan?.digest !== auditPlan.digest) {
    throw new Error("Android bundle flow manifest does not match the requested audit plan.");
  }
  console.log(
    `==> native UI flow manifest copied (${manifest.flows.length} flow(s), plan ${auditPlan.digest.slice(0, 12)})`,
  );
  runAndroid("./gradlew", [":app:assembleDebug"], {
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 20,
  });
}

function installAndLaunch(serial) {
  const credentialRunId = createAndroidCredentialRunId();
  const launchTarget = resolveInitialLaunchTarget();
  const encodedRedirect = encodeURIComponent(launchTarget.route);
  tryRunAdb(serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    stdio: "ignore",
  });
  tryRunAdb(serial, ["shell", "wm", "dismiss-keyguard"], { stdio: "ignore" });
  tryRunAdb(serial, ["shell", "input", "keyevent", "KEYCODE_MENU"], {
    stdio: "ignore",
  });
  tryRunAdb(serial, ["shell", "am", "force-stop", bundleId], {
    stdio: "ignore",
  });
  tryRunAdb(serial, ["uninstall", bundleId], { stdio: "ignore" });
  runAdb(serial, ["install", "-r", "-t", apkPath], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 10,
  });
  const clearOutput = runAdb(serial, ["shell", "pm", "clear", bundleId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!/^success$/i.test(clearOutput.trim())) {
    throw new Error(`Android cold audit could not clear ${bundleId}: ${clearOutput || "unknown error"}`);
  }
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
    "HUSHH_NATIVE_TEST_RUN_UI_FLOWS",
    "true",
    "--es",
    "HUSHH_NATIVE_TEST_UI_FLOW_RUN_ID",
    uiFlowRunId,
    "--es",
    "HUSHH_NATIVE_TEST_CREDENTIAL_RUN_ID",
    credentialRunId,
  ]);
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

function resolveInitialLaunchTarget() {
  return {
    route: "/one",
    marker: "native-route-one-home",
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
  let lastProgressKey = "";
  let lastProgressAt = startedAt;
  let completedReport = null;
  let completedReportObservedAt = 0;
  const highestCheckpointByFlow = new Map();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = readStatus(serial).trim();
      if (raw) {
        lastStatus = parseStatus(raw);
        const checkpoint = advanceNativeUiCheckpoint({
          flows: uiFlows,
          status: lastStatus,
          highestByFlow: highestCheckpointByFlow,
        });
        if (!checkpoint.ok) {
          return {
            ok: false,
            report: readUiReport(serial),
            status: lastStatus,
            error: `Android UI interaction audit ${checkpoint.reason}`,
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
            `\n   -> ${lastStatus.ui_flow || "bootstrap"} / ${lastStatus.ui_step_type || "waiting"} ... `,
          );
          lastProgressKey = progressKey;
          lastProgressAt = Date.now();
        }
        if (hasTerminalNativeUiStatus(lastStatus)) {
          const report = completedReport || readUiReport(serial);
          if (report)
            return { ok: Boolean(report.ok), report, status: lastStatus };
        }
        if ((lastStatus.uifailed || "") === "1") {
          return {
            ok: false,
            report: readUiReport(serial),
            status: lastStatus,
            error: "Android UI interaction audit reported a terminal failure",
          };
        }
        if (
          (lastStatus.uistarted || "") === "1" &&
          (lastStatus.ui_complete || "") !== "1" &&
          Date.now() - lastProgressAt > nativeUiFlowStepTimeoutMs(uiFlows, lastStatus) + 10_000
        ) {
          return {
            ok: false,
            report: readUiReport(serial),
            status: lastStatus,
            error: "Android UI interaction audit stalled without step progress",
          };
        }
      }

      const report = readUiReport(serial);
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
              "Android UI interaction report completed before native terminal status settled",
          };
        }
      }
    } catch {
      // App may still be booting or the debug package may not have created files.
    }

    sleep(1000);
  }

  const report = completedReport || readUiReport(serial);
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

  console.log(
    `==> native Android UI interaction audit (${uiFlows.length} flows)`,
  );
  console.log(`==> audit plan: ${auditPlan.digest.slice(0, 12)}`);
  for (const flow of uiFlows) {
    console.log(`   - ${flow.id} — ${flow.description}`);
  }

  if (process.env.ANDROID_UI_INTERACTION_SKIP_BUILD === "true") {
    throw new Error(
      "ANDROID_UI_INTERACTION_SKIP_BUILD is unsupported: a cold UI audit must build and sync the exact requested flow manifest.",
    );
  }
  buildApp();

  const serial = resolveAdbDevice();
  activeAuditSerial = serial;
  console.log(`==> device: ${serial}`);
  let result;
  try {
    installAndLaunch(serial);
    result = waitForUiInteractionReport(serial);
  } finally {
    cleanupAuditProcess();
  }

  const completion = validateNativeUiAuditCompletion({
    report: result.report,
    status: result.status,
    plan: auditPlan,
    runId: uiFlowRunId,
  });
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
    device: serial,
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
    ok: Boolean(result.ok && completion.ok),
    flows: uiFlows.map((flow) => flow.id),
    report: sanitizedReport,
    errorClass: sanitizedErrorClass || null,
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
    console.log(
      `==> Android UI interactions passed (${summary.passed_flows}/${summary.flow_count}${optionalSuffix}${conditionalSuffix})`,
    );
    return;
  }

  const failed = (sanitizedReport?.flows || []).filter((flow) => !flow.ok);
  for (const flow of failed) {
    console.log(
      `   x ${flow.id}: ${flow.failedStep?.type || flow.results?.slice(-1)[0]?.errorClass || "failed"}`,
    );
  }
  if (result.error) {
    console.log(`   x ${sanitizedErrorClass || "other"}`);
  }
  if (!completion.ok) {
    console.log("   x audit report did not prove the requested plan completed");
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
