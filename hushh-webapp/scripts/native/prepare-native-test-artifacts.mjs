#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  KAI_IMPORT_E2E_ASSET_PATH,
  KAI_IMPORT_E2E_FLOW_ID,
  filterUiFlows,
} from "../testing/signed-in-ui-flows.mjs";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";
import { createNativeUiAuditManifest } from "./native-ui-audit-plan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * The directory Capacitor will actually copy into the app bundle.
 *
 * These artifacts only reach the device if they are written where `cap sync`
 * reads from, and that is not always `out/`. A native build overrides
 * NEXT_DIST_DIR (the iOS UAT lane uses `.next-native-uat`), and
 * capacitor.config.ts resolves `webDir` from the same variable. Writing to a
 * hardcoded `out/` meant the flows manifest, the test runner and the audit
 * assets were produced correctly and then left behind: `cap sync` reported
 * success, copied a directory that did not contain them, and the device build
 * failed at the "was not copied into the iOS app bundle" check with nothing
 * obviously wrong upstream.
 *
 * Resolved exactly as capacitor.config.ts:7 resolves it, so the two cannot
 * disagree again.
 */
function webAssetDir() {
  // NEXT_DIST_DIR is NOT in this process's environment. with-ios-native-env.mjs
  // injects it only into the child it spawns (the Next build and cap sync), so
  // the parent that writes these artifacts never sees it and a plain
  // process.env read silently falls back to "out" -- which is the exact bug
  // this function exists to prevent. Read the same file that script reads.
  const fromEnv = process.env.NEXT_DIST_DIR?.trim();
  if (fromEnv) return fromEnv;
  const nativeEnvPath = path.join(repoRoot, ".env.native.ios.local");
  if (fs.existsSync(nativeEnvPath)) {
    const fromFile = parseEnvFile(nativeEnvPath)?.NEXT_DIST_DIR?.trim();
    if (fromFile) return fromFile;
  }
  return "out";
}

export function writeNativeUiFlowsManifest({
  repoRoot: root = repoRoot,
  flowFilter = "",
  routeFilter = "",
} = {}) {
  const flows = filterUiFlows({ flowFilter, routeFilter });
  const flowsPublicPath = path.join(root, webAssetDir(), "native-ui-flows.json");
  const nativeAuditManifest = createNativeUiAuditManifest(flows);
  fs.mkdirSync(path.dirname(flowsPublicPath), { recursive: true });
  fs.writeFileSync(
    flowsPublicPath,
    `${JSON.stringify(nativeAuditManifest, null, 2)}\n`
  );
  return { flows, flowsPublicPath, nativeAuditManifest };
}

export function copyNativeImportE2eAsset({
  repoRoot: root = repoRoot,
  flows = [],
} = {}) {
  const requiresImportAsset = flows.some((flow) => flow.id === KAI_IMPORT_E2E_FLOW_ID);
  if (!requiresImportAsset) {
    return null;
  }

  const configuredSource = String(process.env.KAI_IMPORT_E2E_FILE || "").trim();
  if (!configuredSource) {
    throw new Error(
      `KAI_IMPORT_E2E_FILE is required for ${KAI_IMPORT_E2E_FLOW_ID} native UI flow.`
    );
  }
  const source = path.resolve(configuredSource);
  if (!fs.existsSync(source)) {
    throw new Error(
      `KAI_IMPORT_E2E_FILE is required for ${KAI_IMPORT_E2E_FLOW_ID} native UI flow.`
    );
  }
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`KAI_IMPORT_E2E_FILE is not a readable non-empty file: ${source}`);
  }

  const relativeAssetPath = KAI_IMPORT_E2E_ASSET_PATH.replace(/^\/+/, "");
  const destination = path.join(root, webAssetDir(), relativeAssetPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  console.log(
    `==> native import E2E asset copied (${path.basename(source)}, ${stat.size} bytes)`
  );
  return destination;
}

export function syncNativeUiTestRunner({ repoRoot: root = repoRoot } = {}) {
  const sourcePath = path.join(root, "scripts/native/native-ui-test-runner-source.js");
  const publicRunnerPath = path.join(root, webAssetDir(), "native-ui-test-runner.js");
  fs.mkdirSync(path.dirname(publicRunnerPath), { recursive: true });
  fs.copyFileSync(sourcePath, publicRunnerPath);

  execSync("node ./scripts/native/sync-native-ui-test-runner.mjs", {
    cwd: root,
    stdio: "inherit",
  });
}

export function patchFirebaseMessagingForNativeTests({
  repoRoot: root = repoRoot,
} = {}) {
  const pluginPath = path.join(
    root,
    "node_modules/@capacitor-firebase/messaging/ios/Plugin/FirebaseMessaging.swift"
  );
  if (!fs.existsSync(pluginPath)) {
    return false;
  }

  const source = fs.readFileSync(pluginPath, "utf8");
  if (source.includes("arguments.contains(\"-UITestMode\")")) {
    return true;
  }

  const target = "        UIApplication.shared.registerForRemoteNotifications()";
  const replacement = [
    "        if !ProcessInfo.processInfo.arguments.contains(\"-UITestMode\") {",
    "            UIApplication.shared.registerForRemoteNotifications()",
    "        }",
  ].join("\n");
  if (!source.includes(target)) {
    throw new Error(
      "Unable to patch @capacitor-firebase/messaging native-test notification prompt guard."
    );
  }
  fs.writeFileSync(pluginPath, source.replace(target, replacement));
  console.log("==> patched Firebase Messaging iOS notification prompt for native tests");
  return true;
}

export function prepareNativeTestArtifacts(options = {}) {
  const manifest = writeNativeUiFlowsManifest(options);
  copyNativeImportE2eAsset({ ...options, flows: manifest.flows });
  syncNativeUiTestRunner(options);
  patchFirebaseMessagingForNativeTests(options);
  return manifest;
}
