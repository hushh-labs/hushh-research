#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../testing/reviewer-test-identity.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nativeRuntimeEnvPath = path.join(appRoot, ".env.native.ios.local");
const allowedKeys = new Set(["APP_RUNTIME_PROFILE", "NEXT_DIST_DIR", "NODE_OPTIONS"]);

function isAllowedNativeBuildKey(key) {
  return allowedKeys.has(key) || key.startsWith("NEXT_PUBLIC_");
}

function loadNativeRuntimeEnv() {
  if (!fs.existsSync(nativeRuntimeEnvPath)) return {};
  return Object.fromEntries(
    Object.entries(parseEnvFile(nativeRuntimeEnvPath)).filter(
      ([key, value]) =>
        isAllowedNativeBuildKey(key) && typeof value === "string" && value.trim(),
    ),
  );
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: with-ios-native-env.mjs <command> [...args]");
  process.exit(2);
}

const nativeRuntimeEnv = loadNativeRuntimeEnv();
const result = spawnSync(command, args, {
  cwd: appRoot,
  env: {
    ...process.env,
    ...nativeRuntimeEnv,
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
