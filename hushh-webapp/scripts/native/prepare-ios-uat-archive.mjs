#!/usr/bin/env node

/**
 * Prepare the generated iOS project for a UAT archive without copying secrets
 * into tracked files. The generated capacitor.config.json is ignored by Git but
 * is what Xcode packages during Archive.
 */

import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const uatEnvPath = path.join(repoRoot, ".env.uat.local");
const configPath = path.join(repoRoot, "ios", "App", "App", "capacitor.config.json");
const verifyScript = path.join(repoRoot, "scripts", "native", "verify-ios-bundled-backend.sh");

function isLocalBackend(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "0.0.0.0", "10.0.2.2"].includes(host);
  } catch {
    return true;
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "(invalid)";
  }
}

function applyEnvValues(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      process.env[key] = value;
    }
  }
}

function ensureUatEnv() {
  const uatValues = parseEnvFile(uatEnvPath);
  const backendUrl = String(uatValues.NEXT_PUBLIC_BACKEND_URL || "").trim().replace(/\/$/, "");

  if (!backendUrl || isLocalBackend(backendUrl)) {
    throw new Error(
      "UAT iOS archive prep requires a non-local NEXT_PUBLIC_BACKEND_URL in hushh-webapp/.env.uat.local."
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

  console.log(`==> UAT native backend host: ${hostname(backendUrl)}`);
  return backendUrl;
}

function main() {
  const backendUrl = ensureUatEnv();
  execSync("npm run cap:build", { cwd: repoRoot, stdio: "inherit", env: process.env });
  execSync("npm run cap:sync:ios", { cwd: repoRoot, stdio: "inherit", env: process.env });
  execFileSync(verifyScript, [configPath, backendUrl], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  console.log("==> iOS project is ready for a UAT Xcode Archive");
}

main();
