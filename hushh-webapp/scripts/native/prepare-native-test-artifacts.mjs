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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export function writeNativeUiFlowsManifest({
  repoRoot: root = repoRoot,
  flowFilter = "",
  routeFilter = "",
} = {}) {
  const flows = filterUiFlows({ flowFilter, routeFilter });
  const flowsPublicPath = path.join(root, "out", "native-ui-flows.json");
  fs.mkdirSync(path.dirname(flowsPublicPath), { recursive: true });
  fs.writeFileSync(
    flowsPublicPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        flow_count: flows.length,
        flows,
      },
      null,
      2
    )}\n`
  );
  return { flows, flowsPublicPath };
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
  const destination = path.join(root, "out", relativeAssetPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  console.log(
    `==> native import E2E asset copied (${path.basename(source)}, ${stat.size} bytes)`
  );
  return destination;
}

export function syncNativeUiTestRunner({ repoRoot: root = repoRoot } = {}) {
  const sourcePath = path.join(root, "scripts/native/native-ui-test-runner-source.js");
  const publicRunnerPath = path.join(root, "out", "native-ui-test-runner.js");
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
