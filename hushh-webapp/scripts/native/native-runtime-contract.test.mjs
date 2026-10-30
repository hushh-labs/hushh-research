import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NATIVE_RUNTIME_ATTESTATION_ENV,
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  attestedNativeRuntimeContractFromEnvironment,
  nativeRuntimeBuildAttestation,
  nativeRuntimeContractFromEnvironment,
  writeNativeRuntimeContract,
} from "./native-runtime-contract.mjs";
import {
  assertNoProtectedNativeBuildOverride,
  prepareIosNativeBuildEnvironment,
} from "./with-ios-native-env.mjs";

const proofEnvironment = {
  NEXT_DIST_DIR: ".next-native-plaid-sandbox",
  NEXT_PUBLIC_BACKEND_URL: "http://127.0.0.1:8000/",
  NEXT_PUBLIC_APP_ENV: "development",
  NEXT_PUBLIC_PLAID_SANDBOX_PROOF: "true",
};

test("records only non-secret runtime values from the completed native build", () => {
  assert.deepEqual(nativeRuntimeContractFromEnvironment(proofEnvironment), {
    schema_version: 1,
    backend_origin: "http://127.0.0.1:8000",
    app_env: "development",
    plaid_sandbox_proof: true,
    dist_dir: ".next-native-plaid-sandbox",
  });
});

test("rejects a missing or credential-bearing backend URL", () => {
  assert.throws(
    () => nativeRuntimeContractFromEnvironment({ ...proofEnvironment, NEXT_PUBLIC_BACKEND_URL: "" }),
    /absolute HTTP\(S\) URL/,
  );
  assert.throws(
    () => nativeRuntimeContractFromEnvironment({ ...proofEnvironment, NEXT_PUBLIC_BACKEND_URL: "https://user:secret@example.test" }),
    /must not contain credentials/,
  );
});

test("writes the contract into the exact native output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-native-contract-"));
  try {
    fs.mkdirSync(path.join(root, ".next-native-plaid-sandbox"));
    const environment = prepareIosNativeBuildEnvironment(proofEnvironment);
    const { outputPath } = writeNativeRuntimeContract({ appRoot: root, environment });
    assert.equal(path.basename(outputPath), NATIVE_RUNTIME_CONTRACT_FILENAME);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(outputPath, "utf8")),
      attestedNativeRuntimeContractFromEnvironment(environment),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("binds proof contracts to the child build environment and rejects child overrides", () => {
  const environment = prepareIosNativeBuildEnvironment({
    ...proofEnvironment,
    [NATIVE_RUNTIME_ATTESTATION_ENV]: "stale",
  });
  assert.equal(
    environment[NATIVE_RUNTIME_ATTESTATION_ENV],
    nativeRuntimeBuildAttestation(nativeRuntimeContractFromEnvironment(proofEnvironment)),
  );
  assert.throws(
    () => assertNoProtectedNativeBuildOverride(["cross-env", "NEXT_PUBLIC_BACKEND_URL=https://api.uat.hushh.ai", "next", "build"]),
    /must be set before invoking/,
  );
  assert.throws(
    () => attestedNativeRuntimeContractFromEnvironment(proofEnvironment),
    /attestation is missing/,
  );
});
