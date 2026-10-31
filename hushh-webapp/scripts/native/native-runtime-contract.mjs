import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const NATIVE_RUNTIME_CONTRACT_FILENAME = "hushh-native-runtime-contract.json";
export const NATIVE_RUNTIME_CONTRACT_VERSION = 1;
export const NATIVE_RUNTIME_ATTESTATION_ENV = "NEXT_PUBLIC_HUSHH_NATIVE_RUNTIME_ATTESTATION";

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeNativeRuntimeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(text(value));
  } catch {
    throw new Error("NEXT_PUBLIC_BACKEND_URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new Error("NEXT_PUBLIC_BACKEND_URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("NEXT_PUBLIC_BACKEND_URL must not contain credentials, a query, or a fragment.");
  }
  return parsed.origin;
}

export function nativeRuntimeContractFromEnvironment(environment = process.env) {
  const distDir = text(environment.NEXT_DIST_DIR);
  if (!distDir) throw new Error("NEXT_DIST_DIR is required for a native build.");
  return {
    schema_version: NATIVE_RUNTIME_CONTRACT_VERSION,
    backend_origin: normalizeNativeRuntimeOrigin(environment.NEXT_PUBLIC_BACKEND_URL),
    app_env: text(environment.NEXT_PUBLIC_APP_ENV),
    plaid_sandbox_proof: text(environment.NEXT_PUBLIC_PLAID_SANDBOX_PROOF) === "true",
    dist_dir: distDir,
  };
}

/**
 * A non-secret fingerprint embedded by Next while it creates the static
 * WebView bundle. The proof guard verifies this against the copied export so
 * a post-build environment cannot relabel a different bundle as local.
 */
export function nativeRuntimeBuildAttestation(contract) {
  const canonical = JSON.stringify({
    schema_version: contract.schema_version,
    backend_origin: contract.backend_origin,
    app_env: contract.app_env,
    plaid_sandbox_proof: contract.plaid_sandbox_proof,
    dist_dir: contract.dist_dir,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function attestedNativeRuntimeContractFromEnvironment(environment = process.env) {
  const contract = nativeRuntimeContractFromEnvironment(environment);
  const bundleAttestation = nativeRuntimeBuildAttestation(contract);
  if (
    contract.plaid_sandbox_proof &&
    text(environment[NATIVE_RUNTIME_ATTESTATION_ENV]) !== bundleAttestation
  ) {
    throw new Error("Native sandbox proof build attestation is missing or does not match its runtime configuration.");
  }
  return { ...contract, bundle_attestation: bundleAttestation };
}

function outputDirectory(appRoot, distDir) {
  const resolved = path.resolve(appRoot, distDir);
  const relative = path.relative(appRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("NEXT_DIST_DIR must resolve below the web-app root.");
  }
  return resolved;
}

export function writeNativeRuntimeContract({ appRoot, environment = process.env }) {
  const contract = attestedNativeRuntimeContractFromEnvironment(environment);
  const directory = outputDirectory(appRoot, contract.dist_dir);
  if (!fs.existsSync(directory)) {
    throw new Error(`Native build output does not exist: ${contract.dist_dir}`);
  }
  const outputPath = path.join(directory, NATIVE_RUNTIME_CONTRACT_FILENAME);
  fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { contract, outputPath };
}
