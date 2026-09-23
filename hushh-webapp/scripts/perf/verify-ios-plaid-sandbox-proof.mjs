#!/usr/bin/env node

/**
 * Fail closed before the opt-in Plaid UI proof can interact with Link.
 *
 * This proof is for a local simulator backed by Plaid Sandbox only.  The
 * normal iOS performance card intentionally targets UAT, so its defaults are
 * never safe for a flow that creates financial connections.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  nativeRuntimeBuildAttestation,
} from "../native/native-runtime-contract.mjs";

const EXPECTED_PROOF_DIST_DIR = ".next-native-plaid-sandbox";

const pluginNames = [
  "HushhVault",
  "HushhConsent",
  "Kai",
  "HushhNotifications",
  "PersonalKnowledgeModel",
  "HushhAccount",
  "HushhSync",
];

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function fail(message) {
  throw new Error(`Plaid sandbox proof is blocked: ${message}`);
}

function parseBackendUrl(value, pluginName) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    fail(`${pluginName} has an invalid native backend URL.`);
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !loopbackHosts.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(`${pluginName} must target a loopback backend, not ${parsed.hostname || "an untrusted host"}.`);
  }

  return parsed.origin;
}

function assertRuntimeContract(contract, backend) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail("the bundled runtime contract is missing.");
  }
  if (contract.schema_version !== 1) {
    fail("the bundled runtime contract version is not supported.");
  }
  if (contract.dist_dir !== EXPECTED_PROOF_DIST_DIR) {
    fail("the bundled runtime contract does not name the local sandbox export.");
  }
  if (contract.app_env !== "development") {
    fail("the bundled WebView is not a development build.");
  }
  if (contract.plaid_sandbox_proof !== true) {
    fail("the bundled WebView was not compiled for the explicit sandbox proof.");
  }
  if (contract.bundle_attestation !== nativeRuntimeBuildAttestation(contract)) {
    fail("the bundled WebView runtime attestation does not match its configuration.");
  }
  if (parseBackendUrl(contract.backend_origin, "bundled WebView") !== backend) {
    fail("the bundled WebView and native plugins target different backends.");
  }
}

export function assertIosPlaidSandboxProof({ environment = process.env, config, runtimeContract }) {
  if (environment.HUSHH_PLAID_SANDBOX_PROOF !== "true") {
    fail("set HUSHH_PLAID_SANDBOX_PROOF=true for this local-only proof.");
  }
  if (environment.PLAID_ENV !== "sandbox") {
    fail("set PLAID_ENV=sandbox; hosted UAT and production are never accepted.");
  }
  if (environment.PERF_ATTACHED !== "1") {
    fail("set PERF_ATTACHED=1 so the opt-in attached lane is used.");
  }
  if (environment.IOS_DEVICE_ID) {
    fail("a physical device is not permitted; use an iOS Simulator.");
  }

  const distDir = String(environment.NEXT_DIST_DIR || "").trim();
  if (distDir !== EXPECTED_PROOF_DIST_DIR || path.isAbsolute(distDir) || path.normalize(distDir) !== distDir) {
    fail(`set NEXT_DIST_DIR=${EXPECTED_PROOF_DIST_DIR}; no other export is permitted.`);
  }

  const plugins = config?.plugins;
  if (!plugins || typeof plugins !== "object") {
    fail("the generated Capacitor configuration is missing.");
  }

  const backends = pluginNames.map((pluginName) => {
    const value = plugins[pluginName]?.backendUrl;
    if (!value) fail(`${pluginName} has no native backend URL.`);
    return parseBackendUrl(value, pluginName);
  });

  if (new Set(backends).size !== 1) {
    fail("native plugins do not all target the same local backend.");
  }
  assertRuntimeContract(runtimeContract, backends[0]);

  return { backend: backends[0], distDir };
}

function requiredCliValue(name) {
  const value = cliValue(name);
  if (!value) fail(`pass ${name} <path>.`);
  return value;
}

function requireExactProofExport(rawPath) {
  if (rawPath !== EXPECTED_PROOF_DIST_DIR || path.isAbsolute(rawPath) || path.normalize(rawPath) !== rawPath) {
    fail(`pass --export ${EXPECTED_PROOF_DIST_DIR}; no other export is permitted.`);
  }
  const resolved = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail("the local sandbox export cannot be read.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("the local sandbox export must be a real directory, not a symlink.");
  }
  return resolved;
}

function assertExportedRuntimeAttestation(exportDirectory, contract) {
  if (typeof contract?.bundle_attestation !== "string" || !/^[a-f0-9]{64}$/.test(contract.bundle_attestation)) {
    fail("the bundled WebView runtime attestation is missing.");
  }
  let indexHtml;
  try {
    indexHtml = fs.readFileSync(path.join(exportDirectory, "index.html"), "utf8");
  } catch {
    fail("the proof export is missing its bundled WebView entrypoint.");
  }
  const runtimeMarker = `window.__HUSHH_NATIVE_RUNTIME_ATTESTATION__=${JSON.stringify(contract.bundle_attestation)};`;
  if (
    !indexHtml.includes('id="hushh-native-runtime-attestation"') ||
    !indexHtml.includes(runtimeMarker)
  ) {
    fail("the exported WebView was not built with the matching runtime attestation.");
  }
}

export function readMatchingRuntimeContract({ exportDir, nativePublicDir }) {
  const resolvedExport = requireExactProofExport(exportDir);
  const resolvedNativePublic = path.resolve(nativePublicDir);
  const exportContractPath = path.join(resolvedExport, NATIVE_RUNTIME_CONTRACT_FILENAME);
  const nativeContractPath = path.join(resolvedNativePublic, NATIVE_RUNTIME_CONTRACT_FILENAME);
  let exportBytes;
  let nativeBytes;
  try {
    exportBytes = fs.readFileSync(exportContractPath);
    nativeBytes = fs.readFileSync(nativeContractPath);
  } catch {
    fail("the runtime contract was not copied from the proof export into the iOS app.");
  }
  if (!exportBytes.equals(nativeBytes)) {
    fail("the iOS app runtime contract differs from the proof export.");
  }
  let contract;
  try {
    contract = JSON.parse(exportBytes.toString("utf8"));
  } catch {
    fail("the bundled runtime contract cannot be parsed.");
  }
  assertExportedRuntimeAttestation(resolvedExport, contract);
  return contract;
}

function cliValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function main() {
  const configPath = requiredCliValue("--config");
  const exportDir = requiredCliValue("--export");
  const nativePublicDir = requiredCliValue("--native-public");

  const resolvedConfigPath = path.resolve(configPath);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8"));
  } catch {
    fail("the generated Capacitor configuration cannot be read.");
  }

  const runtimeContract = readMatchingRuntimeContract({ exportDir, nativePublicDir });
  const result = assertIosPlaidSandboxProof({ config, runtimeContract });
  console.log(`Plaid sandbox proof guard passed for ${new URL(result.backend).hostname}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
