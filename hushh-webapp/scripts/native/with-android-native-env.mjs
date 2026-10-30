#!/usr/bin/env node
/**
 * Run a command with the Android native build environment.
 *
 * The sibling with-ios-native-env.mjs overlays .env.native.ios.local on the
 * process environment, including its NEXT_DIST_DIR (.next-native-uat). The
 * Android lanes share that runtime env (same backend, same Firebase project)
 * but must never build into the iOS dist dir: the two lanes build
 * concurrently, and capacitor.config.ts resolves webDir from NEXT_DIST_DIR.
 * This wrapper therefore:
 *
 *   1. loads .env.native.android.local when present, else .env.native.ios.local,
 *      keeping only the allowed build keys (same allow-list as iOS);
 *   2. pins NEXT_DIST_DIR to the caller's value or `.next-native-android`,
 *      never the env file's;
 *   3. fills NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY from
 *      .env.<APP_RUNTIME_PROFILE>.local when the native file lacks it, because
 *      android/app/build.gradle reads that key from the process environment
 *      (an empty value builds a Map surface that renders as unavailable).
 *
 * Usage: node scripts/native/with-android-native-env.mjs <command> [...args]
 *        node scripts/native/with-android-native-env.mjs --print NEXT_PUBLIC_BACKEND_URL
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowedKeys = new Set(["APP_RUNTIME_PROFILE", "NEXT_DIST_DIR", "NODE_OPTIONS"]);
const DEFAULT_DIST_DIR = ".next-native-android";
const MAPS_KEY = "NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY";

function isAllowedNativeBuildKey(key) {
  return allowedKeys.has(key) || key.startsWith("NEXT_PUBLIC_");
}

function loadAllowed(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    Object.entries(parseEnvFile(file)).filter(
      ([key, value]) => isAllowedNativeBuildKey(key) && typeof value === "string" && value.trim(),
    ),
  );
}

export function resolveAndroidNativeEnv(baseEnv = process.env) {
  const nativeFile = [".env.native.android.local", ".env.native.ios.local"]
    .map((name) => path.join(appRoot, name))
    .find((file) => fs.existsSync(file));
  const nativeEnv = nativeFile ? loadAllowed(nativeFile) : {};
  delete nativeEnv.NEXT_DIST_DIR;
  const merged = { ...baseEnv, ...nativeEnv };
  merged.NEXT_DIST_DIR = (baseEnv.NEXT_DIST_DIR || "").trim() || DEFAULT_DIST_DIR;
  if (!merged[MAPS_KEY]) {
    const profile = (merged.APP_RUNTIME_PROFILE || "uat").trim();
    const profileEnv = loadAllowed(path.join(appRoot, `.env.${profile}.local`));
    if (profileEnv[MAPS_KEY]) merged[MAPS_KEY] = profileEnv[MAPS_KEY];
  }
  return { env: merged, sourceFile: nativeFile ? path.basename(nativeFile) : null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: with-android-native-env.mjs <command> [...args] | --print <KEY>");
    process.exit(2);
  }
  const { env } = resolveAndroidNativeEnv();
  if (command === "--print") {
    // Only non-secret build keys are printable by name; never dumps the env.
    const key = args[0] || "";
    if (!/^(APP_RUNTIME_PROFILE|NEXT_DIST_DIR|NEXT_PUBLIC_BACKEND_URL|NEXT_PUBLIC_APP_ENV)$/.test(key)) {
      console.error(`with-android-native-env: ${key || "(none)"} is not a printable key.`);
      process.exit(2);
    }
    process.stdout.write(`${env[key] ?? ""}\n`);
    process.exit(0);
  }
  const result = spawnSync(command, args, { cwd: appRoot, env, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
