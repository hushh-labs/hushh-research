#!/usr/bin/env node

/**
 * Build UAT native iOS app + UI flow artifacts for device or simulator XCUITest.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";
import { prepareNativeTestArtifacts } from "./prepare-native-test-artifacts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    throw new Error("device UI test requires UAT NEXT_PUBLIC_BACKEND_URL (.env.uat.local).");
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

function main() {
  ensureNativeTestBuildEnv();
  execSync("npm run cap:build", { cwd: repoRoot, stdio: "inherit", env: process.env });
  const manifest = prepareNativeTestArtifacts({
    flowFilter: process.env.IOS_UI_FLOW_FILTER || "",
    routeFilter: process.env.IOS_UI_ROUTE_FILTER || "",
  });
  execSync("npm run cap:sync:ios", { cwd: repoRoot, stdio: "inherit", env: process.env });
  const copiedManifestPath = path.join(repoRoot, "ios/App/App/public/native-ui-flows.json");
  if (!fs.existsSync(copiedManifestPath)) {
    throw new Error("native-ui-flows.json was not copied into the iOS app bundle.");
  }
  console.log(`==> native UI flow manifest copied (${manifest.flows.length} flow(s))`);
}

main();
