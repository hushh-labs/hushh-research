#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNativeBuildEnvironment } from "./native-build-environment.mjs";
import {
  NATIVE_RUNTIME_ATTESTATION_ENV,
  nativeRuntimeBuildAttestation,
  nativeRuntimeContractFromEnvironment,
  writeNativeRuntimeContract,
} from "./native-runtime-contract.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const protectedNativeBuildKeys = new Set([
  "APP_RUNTIME_PROFILE",
  "NEXT_DIST_DIR",
  "NEXT_PUBLIC_BACKEND_URL",
  "NEXT_PUBLIC_APP_ENV",
  "NEXT_PUBLIC_PLAID_SANDBOX_PROOF",
  NATIVE_RUNTIME_ATTESTATION_ENV,
]);

export function resolveIosNativeEnv(baseEnv = process.env) {
  return resolveNativeBuildEnvironment({ appRoot, env: baseEnv });
}

export function isNextBuildInvocation(command, args) {
  return ["npx", "npx.cmd"].includes(path.basename(command)) && args.includes("next") && args.includes("build");
}

export function assertNoProtectedNativeBuildOverride(args) {
  for (const argument of args) {
    const key = String(argument).match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    if (key && protectedNativeBuildKeys.has(key)) {
      throw new Error(`with-ios-native-env: ${key} must be set before invoking the native build, not overridden by its child command.`);
    }
  }
}

export function prepareIosNativeBuildEnvironment(environment) {
  const buildEnvironment = { ...environment };
  delete buildEnvironment[NATIVE_RUNTIME_ATTESTATION_ENV];
  const contract = nativeRuntimeContractFromEnvironment(buildEnvironment);
  if (contract.plaid_sandbox_proof) {
    buildEnvironment[NATIVE_RUNTIME_ATTESTATION_ENV] = nativeRuntimeBuildAttestation(contract);
  }
  return buildEnvironment;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: with-ios-native-env.mjs <command> [...args]");
    process.exit(2);
  }
  const environment = resolveIosNativeEnv();
  const nextBuild = isNextBuildInvocation(command, args);
  let buildEnvironment = environment;
  if (nextBuild) {
    try {
      assertNoProtectedNativeBuildOverride(args);
      buildEnvironment = prepareIosNativeBuildEnvironment(environment);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
  const result = spawnSync(command, args, { cwd: appRoot, env: buildEnvironment, stdio: "inherit" });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

  if (nextBuild) {
    try {
      const { contract, outputPath } = writeNativeRuntimeContract({ appRoot, environment: buildEnvironment });
      console.log(`native runtime contract: ${path.relative(appRoot, outputPath)} (${contract.backend_origin})`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
