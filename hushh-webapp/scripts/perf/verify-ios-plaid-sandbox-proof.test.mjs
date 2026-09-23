import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nativeRuntimeBuildAttestation } from "../native/native-runtime-contract.mjs";
import { assertIosPlaidSandboxProof, readMatchingRuntimeContract } from "./verify-ios-plaid-sandbox-proof.mjs";

const localConfig = (backend = "http://127.0.0.1:8000") => ({
  plugins: Object.fromEntries(
    [
      "HushhVault",
      "HushhConsent",
      "Kai",
      "HushhNotifications",
      "PersonalKnowledgeModel",
      "HushhAccount",
      "HushhSync",
    ].map((name) => [name, { backendUrl: backend }]),
  ),
});

const sandboxEnvironment = {
  HUSHH_PLAID_SANDBOX_PROOF: "true",
  PLAID_ENV: "sandbox",
  PERF_ATTACHED: "1",
  NEXT_DIST_DIR: ".next-native-plaid-sandbox",
};

const runtimeContract = (backend = "http://127.0.0.1:8000") => {
  const contract = {
    schema_version: 1,
    backend_origin: backend,
    app_env: "development",
    plaid_sandbox_proof: true,
    dist_dir: ".next-native-plaid-sandbox",
  };
  return { ...contract, bundle_attestation: nativeRuntimeBuildAttestation(contract) };
};

test("allows an explicitly opted-in local Simulator sandbox proof", () => {
  assert.deepEqual(assertIosPlaidSandboxProof({ environment: sandboxEnvironment, config: localConfig(), runtimeContract: runtimeContract() }), {
    backend: "http://127.0.0.1:8000",
    distDir: ".next-native-plaid-sandbox",
  });
});

test("rejects missing opt-in, UAT exports, devices, and non-sandbox environments", () => {
  for (const environment of [
    { ...sandboxEnvironment, HUSHH_PLAID_SANDBOX_PROOF: "" },
    { ...sandboxEnvironment, PLAID_ENV: "production" },
    { ...sandboxEnvironment, PERF_ATTACHED: "0" },
    { ...sandboxEnvironment, IOS_DEVICE_ID: "device-id" },
    { ...sandboxEnvironment, NEXT_DIST_DIR: ".next-native-uat" },
    { ...sandboxEnvironment, NEXT_DIST_DIR: ".next-native-prod" },
    { ...sandboxEnvironment, NEXT_DIST_DIR: "./.next-native-plaid-sandbox" },
  ]) {
    assert.throws(() => assertIosPlaidSandboxProof({ environment, config: localConfig(), runtimeContract: runtimeContract() }), /blocked/);
  }
});

test("rejects hosted and inconsistent native backend targets", () => {
  for (const backend of ["https://api.uat.hushh.ai", "http://0.0.0.0:8000", "http://10.0.2.2:8000"]) {
    assert.throws(
      () => assertIosPlaidSandboxProof({ environment: sandboxEnvironment, config: localConfig(backend), runtimeContract: runtimeContract() }),
      /loopback backend/,
    );
  }

  const inconsistent = localConfig();
  inconsistent.plugins.Kai.backendUrl = "http://localhost:8000";
  assert.throws(
    () => assertIosPlaidSandboxProof({ environment: sandboxEnvironment, config: inconsistent, runtimeContract: runtimeContract() }),
    /same local backend/,
  );
});

test("rejects a hosted, unmarked, or mismatched bundled WebView contract", () => {
  for (const contract of [
    runtimeContract("https://api.uat.hushh.ai"),
    { ...runtimeContract(), app_env: "uat" },
    { ...runtimeContract(), plaid_sandbox_proof: false },
    { ...runtimeContract(), dist_dir: ".next-native-uat" },
  ]) {
    assert.throws(
      () => assertIosPlaidSandboxProof({ environment: sandboxEnvironment, config: localConfig(), runtimeContract: contract }),
      /blocked/,
    );
  }
});

test("requires the generated proof contract to be copied byte-for-byte into the iOS app", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-plaid-proof-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    fs.mkdirSync(".next-native-plaid-sandbox");
    fs.mkdirSync("ios-public");
    const serialized = `${JSON.stringify(runtimeContract(), null, 2)}\n`;
    fs.writeFileSync(
      ".next-native-plaid-sandbox/index.html",
      `<script id="hushh-native-runtime-attestation">window.__HUSHH_NATIVE_RUNTIME_ATTESTATION__=${JSON.stringify(runtimeContract().bundle_attestation)};</script>`,
    );
    fs.writeFileSync(".next-native-plaid-sandbox/hushh-native-runtime-contract.json", serialized);
    fs.writeFileSync("ios-public/hushh-native-runtime-contract.json", serialized);
    assert.deepEqual(
      readMatchingRuntimeContract({ exportDir: ".next-native-plaid-sandbox", nativePublicDir: "ios-public" }),
      runtimeContract(),
    );
    fs.writeFileSync("ios-public/hushh-native-runtime-contract.json", `${JSON.stringify({ ...runtimeContract(), app_env: "uat" })}\n`);
    assert.throws(
      () => readMatchingRuntimeContract({ exportDir: ".next-native-plaid-sandbox", nativePublicDir: "ios-public" }),
      /differs from the proof export/,
    );
    fs.writeFileSync("ios-public/hushh-native-runtime-contract.json", serialized);
    fs.writeFileSync(".next-native-plaid-sandbox/index.html", "<script></script>");
    assert.throws(
      () => readMatchingRuntimeContract({ exportDir: ".next-native-plaid-sandbox", nativePublicDir: "ios-public" }),
      /runtime attestation/,
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runs the guard before reviewer resolution and never exports Plaid screenshots", () => {
  const card = fs.readFileSync(path.join(import.meta.dirname, "ios-perf-card.sh"), "utf8");
  const swift = fs.readFileSync(
    path.join(import.meta.dirname, "../../ios/App/AppUITests/AppUITests.swift"),
    "utf8",
  );
  const layout = fs.readFileSync(path.join(import.meta.dirname, "../../app/layout.tsx"), "utf8");
  assert.ok(
    card.indexOf("verify-ios-plaid-sandbox-proof.mjs") < card.indexOf("export-reviewer-test-env.mjs"),
    "the proof guard must run before reviewer credentials are resolved",
  );
  assert.match(card, /if \[\[ "\$SECTION" == "session" && -d "\$RESULT_BUNDLE" \]\]/);
  assert.doesNotMatch(card, /\|\| "\$\{PERF_SECTION:-\}" == "plaid-vault"/);
  assert.match(card, /--export "\$NATIVE_EXPORT"/);
  assert.match(card, /--native-public "\$WEB_DIR\/ios\/App\/App\/public"/);
  assert.match(card, /cleanup_plaid_sandbox_proof/);
  assert.match(card, /PERF_OUT_DIR is not allowed for Plaid sandbox proof/);
  assert.match(layout, /NEXT_PUBLIC_HUSHH_NATIVE_RUNTIME_ATTESTATION/);
  assert.match(layout, /id="hushh-native-runtime-attestation"/);
  const proofGuard = swift.slice(
    swift.indexOf("func testRenderPerformanceCardAttached"),
    swift.indexOf("let passphrase", swift.indexOf("func testRenderPerformanceCardAttached")),
  );
  assert.ok(
    proofGuard.indexOf("let plaidSandboxProof") < proofGuard.indexOf("HUSHH_ENABLE_PERF_ATTACHED"),
    "proof sections must be identified before the generic skip",
  );
  assert.match(proofGuard, /Plaid proof requires HUSHH_ENABLE_PERF_ATTACHED=true/);
  assert.match(proofGuard, /XCTFail\("Plaid proof requires/);
  assert.match(proofGuard, /XCTFail\("Plaid proof is restricted/);
  assert.match(proofGuard, /if plaidSandboxProof \{\s*XCTFail\("Plaid proof requires HUSHH_ENABLE_PERF_ATTACHED=true/);
  assert.match(swift, /-CapacitorStorage\.hushh_plaid_sandbox_proof/);
  assert.match(swift, /HUSHH_PLAID_START_INDEX must be an integer from 0 through/);
  assert.match(swift, /XCTAssertEqual\(\s*connected,\s*expectedConnections/);
});
