#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const androidDir = path.join(repoRoot, "android");

function runStep(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function main() {
  runStep("surface map contract", "npm", ["run", "verify:surface-map"]);
  runStep("Capacitor static parity", "npm", ["run", "verify:capacitor:static"]);
  runStep("Capacitor plugin contracts", "npm", ["run", "verify:capacitor:plugins"]);
  runStep("Xcode project listing", "xcodebuild", [
    "-list",
    "-project",
    "ios/App/App.xcodeproj",
  ]);
  runStep("Gradle task listing", "./gradlew", ["tasks", "--all"], {
    cwd: androidDir,
  });
  runStep("iOS simulator route audit", "npm", ["run", "ios:test"]);
  runStep("Android emulator route audit", "npm", ["run", "android:test"]);
  runStep("Android emulator UI interaction audit", "npm", ["run", "android:ui:test"]);
  runStep("native parity report freshness", "npm", [
    "run",
    "verify:capacitor:reports",
  ]);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
