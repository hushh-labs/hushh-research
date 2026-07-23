#!/usr/bin/env node

/**
 * Prepare the generated iOS project for a production archive without copying
 * secrets into tracked files. The generated capacitor.config.json is ignored by
 * Git but is what Xcode packages during Archive.
 */

import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prodEnvPath = path.join(repoRoot, ".env.prod.local");
const configPath = path.join(repoRoot, "ios", "App", "App", "capacitor.config.json");
const verifyScript = path.join(repoRoot, "scripts", "native", "verify-ios-bundled-backend.sh");

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "(invalid)";
  }
}

function isLocalBackend(value) {
  const host = hostname(value);
  return ["localhost", "127.0.0.1", "0.0.0.0", "10.0.2.2", "(invalid)"].includes(host);
}

function isUatBackend(value) {
  const host = hostname(value);
  return host.includes("uat") || host.includes("f2gsa4kfsq");
}

function applyEnvValues(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      process.env[key] = value;
    }
  }
}

function ensureProdEnv() {
  // CI and isolated release worktrees can inject the public production build
  // contract through the process environment. Keep the ignored local overlay as
  // the developer default, but let explicit environment values win.
  const prodValues = {
    ...parseEnvFile(prodEnvPath),
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          (key === "APP_RUNTIME_PROFILE" || key.startsWith("NEXT_PUBLIC_")) &&
          typeof value === "string" &&
          value.trim().length > 0,
      ),
    ),
  };
  const backendUrl = String(prodValues.NEXT_PUBLIC_BACKEND_URL || "").trim().replace(/\/$/, "");

  if (!backendUrl || isLocalBackend(backendUrl) || isUatBackend(backendUrl)) {
    throw new Error(
      "Production iOS archive prep requires a production NEXT_PUBLIC_BACKEND_URL in hushh-webapp/.env.prod.local."
    );
  }

  const appEnv = String(prodValues.NEXT_PUBLIC_APP_ENV || "production").trim();
  if (appEnv !== "production") {
    throw new Error("Production iOS archive prep requires NEXT_PUBLIC_APP_ENV=production.");
  }

  applyEnvValues({
    NEXT_DIST_DIR: ".next-native-prod",
    APP_RUNTIME_PROFILE: prodValues.APP_RUNTIME_PROFILE || "prod",
    NEXT_PUBLIC_APP_ENV: "production",
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    NEXT_PUBLIC_APP_URL: prodValues.NEXT_PUBLIC_APP_URL || "https://one.hushh.ai",
    NEXT_PUBLIC_PASSKEY_RP_ID: prodValues.NEXT_PUBLIC_PASSKEY_RP_ID || "one.hushh.ai",
    NEXT_PUBLIC_FIREBASE_API_KEY: prodValues.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY: prodValues.NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: prodValues.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: prodValues.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: prodValues.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
      prodValues.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: prodValues.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_VAPID_KEY: prodValues.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: prodValues.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
    NEXT_PUBLIC_OBSERVABILITY_ENABLED: prodValues.NEXT_PUBLIC_OBSERVABILITY_ENABLED,
    NEXT_PUBLIC_OBSERVABILITY_DEBUG: prodValues.NEXT_PUBLIC_OBSERVABILITY_DEBUG,
    NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE: prodValues.NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE,
  });

  console.log(`==> Production native backend host: ${hostname(backendUrl)}`);
  return backendUrl;
}

function main() {
  const backendUrl = ensureProdEnv();
  execSync("npm run cap:build", { cwd: repoRoot, stdio: "inherit", env: process.env });
  execSync("npm run cap:sync:ios", { cwd: repoRoot, stdio: "inherit", env: process.env });
  execFileSync(verifyScript, [configPath, backendUrl], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  console.log("==> iOS project is ready for a production Xcode Archive");
}

main();
