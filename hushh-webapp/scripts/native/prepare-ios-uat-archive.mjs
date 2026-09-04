#!/usr/bin/env node

/**
 * Prepare the generated iOS project for a UAT archive without copying secrets
 * into tracked files. The generated capacitor.config.json is ignored by Git but
 * is what Xcode packages during Archive.
 */

import path from "node:path";
import fs from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const uatEnvPath = path.join(repoRoot, ".env.uat.local");
const localEnvPath = path.join(repoRoot, ".env.local");
const nativeRuntimeEnvPath = path.join(repoRoot, ".env.native.ios.local");
const configPath = path.join(repoRoot, "ios", "App", "App", "capacitor.config.json");
const verifyScript = path.join(repoRoot, "scripts", "native", "verify-ios-bundled-backend.sh");
const DEFAULT_UAT_BACKEND_URL = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app";
const DEFAULT_UAT_APP_URL = "https://uat.one.hushh.ai";
const DEFAULT_PASSKEY_RP_ID = "one.hushh.ai";

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

function sanitizeConfiguredValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/replace_with_/i.test(trimmed)) return "";
  if (/your_[a-z0-9_]+_here/i.test(trimmed)) return "";
  if (/placeholder/i.test(trimmed)) return "";
  if (/<[^>]+>/.test(trimmed)) return "";
  return trimmed;
}

function firstConfiguredValue(key, sources, fallback = "") {
  for (const source of sources) {
    const value = sanitizeConfiguredValue(source?.[key]);
    if (value) return value;
  }
  return fallback;
}

export function buildIosUatRuntimeEnv({
  processEnv = process.env,
  uatValues = parseEnvFile(uatEnvPath),
  localValues = parseEnvFile(localEnvPath),
} = {}) {
  const backendUrl = firstConfiguredValue(
    "NEXT_PUBLIC_BACKEND_URL",
    [processEnv, uatValues],
    DEFAULT_UAT_BACKEND_URL,
  ).replace(/\/$/, "");

  const publicSources = [processEnv, uatValues, localValues];
  return {
    NEXT_DIST_DIR: firstConfiguredValue(
      "NEXT_DIST_DIR",
      [processEnv],
      ".next-native-uat",
    ),
    NODE_OPTIONS: firstConfiguredValue(
      "NODE_OPTIONS",
      [processEnv],
      "--max-old-space-size=8192",
    ),
    APP_RUNTIME_PROFILE: "uat",
    NEXT_PUBLIC_APP_ENV: "uat",
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    NEXT_PUBLIC_APP_URL: firstConfiguredValue(
      "NEXT_PUBLIC_APP_URL",
      [processEnv, uatValues],
      DEFAULT_UAT_APP_URL,
    ),
    NEXT_PUBLIC_PASSKEY_RP_ID: firstConfiguredValue(
      "NEXT_PUBLIC_PASSKEY_RP_ID",
      [processEnv, uatValues],
      DEFAULT_PASSKEY_RP_ID,
    ),
    NEXT_PUBLIC_FIREBASE_API_KEY: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_API_KEY",
      publicSources,
    ),
    NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY: firstConfiguredValue(
      "NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY",
      publicSources,
    ),
    // The onboarding map picker loads Google Maps JS via the browser key
    // (getBrowserMapsApiKey). Next inlines NEXT_PUBLIC_* at build time, so this
    // must be bundled or the picker resolves an empty key and never loads the map.
    NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY: firstConfiguredValue(
      "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_APP_ID: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_APP_ID",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_VAPID_KEY: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
      publicSources,
    ),
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
      publicSources,
    ),
    NEXT_PUBLIC_GTM_ID: firstConfiguredValue("NEXT_PUBLIC_GTM_ID", publicSources),
    NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION: firstConfiguredValue(
      "NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION",
      publicSources,
      "false",
    ),
    NEXT_PUBLIC_OBSERVABILITY_ENABLED: firstConfiguredValue(
      "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
      publicSources,
      "true",
    ),
    NEXT_PUBLIC_OBSERVABILITY_DEBUG: firstConfiguredValue(
      "NEXT_PUBLIC_OBSERVABILITY_DEBUG",
      publicSources,
      "false",
    ),
    NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE: firstConfiguredValue(
      "NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE",
      publicSources,
      "1",
    ),
    NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED: firstConfiguredValue(
      "NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED",
      publicSources,
      "false",
    ),
  };
}

function writeNativeRuntimeEnv(values) {
  const lines = [
    "# Generated by npm run ios:prepare:uat.",
    "# Ignored by Git. Keeps follow-up cap:build/cap:sync:ios on the same native UAT runtime.",
    ...Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${String(value)}`),
    "",
  ];
  fs.writeFileSync(nativeRuntimeEnvPath, lines.join("\n"), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function ensureUatEnv() {
  // CI and isolated release worktrees inject the public UAT build contract
  // through the process environment. Keep the ignored local overlay as the
  // developer default, but let an explicit environment value win so the
  // archive is reproducible from the exact release SHA.
  const runtimeValues = buildIosUatRuntimeEnv();
  const backendUrl = runtimeValues.NEXT_PUBLIC_BACKEND_URL;

  if (!backendUrl || isLocalBackend(backendUrl)) {
    throw new Error(
      "UAT iOS archive prep requires a non-local NEXT_PUBLIC_BACKEND_URL in hushh-webapp/.env.uat.local."
    );
  }

  applyEnvValues(runtimeValues);
  writeNativeRuntimeEnv(runtimeValues);

  console.log(`==> UAT native backend host: ${hostname(backendUrl)}`);
  console.log(
    `==> UAT native runtime env: ${path.relative(repoRoot, nativeRuntimeEnvPath)}`
  );
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
