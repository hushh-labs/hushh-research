#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNativeBuildEnvironment } from "./native-build-environment.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: with-ios-native-env.mjs <command> [...args]");
  process.exit(2);
}

const nativeRuntimeEnv = resolveNativeBuildEnvironment({ appRoot });
const result = spawnSync(command, args, {
  cwd: appRoot,
  env: nativeRuntimeEnv,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
