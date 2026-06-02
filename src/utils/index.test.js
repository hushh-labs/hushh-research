"use strict";

/**
 * Integration test for src/utils/index.js
 *
 * Proves workspace reachability of the unified @hushh/utils entry point:
 *   - validateConsentPayload is importable and correctly intercepts both
 *     valid and structurally invalid consent action payloads
 *   - maskUserIdentifier is importable and produces compliant masked output
 *
 * Exits with code 0 on complete success; code 1 on any failure.
 */

const assert = require("assert");
const utils  = require("./index");

let totalPassed = 0;
let totalFailed = 0;

function runTest(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    totalPassed++;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    totalFailed++;
  }
}

// ── Suite 1: Registry surface — both exports are reachable ────────────────────

console.log("\n[Suite 1] Registry surface — exports are reachable through index");

runTest(
  "utils.validateConsentPayload is exported as a function",
  () => assert.strictEqual(typeof utils.validateConsentPayload, "function")
);

runTest(
  "utils.maskUserIdentifier is exported as a function",
  () => assert.strictEqual(typeof utils.maskUserIdentifier, "function")
);

// ── Suite 2: Consent validation lifecycle through the unified entry point ─────

console.log("\n[Suite 2] validateConsentPayload — valid payload resolves correctly");

runTest(
  "valid consent action payload returns { valid: true } through index",
  () => {
    const result = utils.validateConsentPayload({
      userId:          "usr_hushh_2026",
      requestId:       "req_consent_abc123",
      vaultOwnerToken: "hushh_consent:vault.owner.sig",
    });
    assert.strictEqual(result.valid, true,
      `Expected valid:true through index layer. Got: ${JSON.stringify(result)}`);
  }
);

runTest(
  "sanitized payload returned by index matches the input object reference",
  () => {
    const payload = {
      userId:          "usr_hushh_2026",
      requestId:       "req_consent_abc123",
      vaultOwnerToken: "hushh_consent:vault.owner.sig",
    };
    const result = utils.validateConsentPayload(payload);
    assert.strictEqual(result.sanitized, payload);
  }
);

console.log("\n[Suite 3] validateConsentPayload — broken payload is intercepted");

runTest(
  "payload with numeric userId is rejected — proves production path catches corrupted structure",
  () => {
    const result = utils.validateConsentPayload({
      userId:          42,           // wrong type
      requestId:       "req_abc",
      vaultOwnerToken: "hushh_consent:vault.abc.sig",
    });
    assert.strictEqual(result.valid, false,
      "Corrupted userId type must be caught before reaching the consent backend");
    assert.ok(result.error.toLowerCase().includes("userid"),
      `Error must identify the offending field. Got: "${result.error}"`);
  }
);

runTest(
  "payload missing requestId is rejected — mirrors route.ts 400 guard",
  () => {
    const result = utils.validateConsentPayload({
      userId:          "usr_test",
      vaultOwnerToken: "hushh_consent:vault.abc.sig",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("requestid"));
  }
);

runTest(
  "payload missing vaultOwnerToken is rejected — mirrors api-service.ts 401 guard",
  () => {
    const result = utils.validateConsentPayload({
      userId:    "usr_test",
      requestId: "req_abc",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("vaultownertoken"));
  }
);

runTest(
  "payload with exportKey is rejected — ZK mode guard passed through index",
  () => {
    const result = utils.validateConsentPayload({
      userId:          "usr_test",
      requestId:       "req_abc",
      vaultOwnerToken: "hushh_consent:vault.abc.sig",
      exportKey:       "plaintext-key",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("exportkey"));
  }
);

runTest(
  "null payload returns valid:false without throwing — safe fallback through index",
  () => {
    const result = utils.validateConsentPayload(null);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

// ── Suite 4: maskUserIdentifier — functional through the unified entry point ──

console.log("\n[Suite 4] maskUserIdentifier — consent-minimisation exposed through index");

runTest(
  "email address is masked to first-and-last-char form through index",
  () => {
    const result = utils.maskUserIdentifier("abdulgaffar@hushh.ai");
    assert.strictEqual(result, "a***r@hushh.ai",
      "maskUserIdentifier must be fully functional through the index layer");
  }
);

runTest(
  "phone number is masked to last-4-digits form through index",
  () => {
    const result = utils.maskUserIdentifier("1234567890");
    assert.strictEqual(result, "******7890");
  }
);

runTest(
  "E.164 phone preserves last 4 digits through index",
  () => {
    const result = utils.maskUserIdentifier("+15551234567");
    assert.ok(result.endsWith("4567"),
      `Expected last 4 digits preserved, got: ${result}`);
    assert.ok(result.includes("*"));
  }
);

runTest(
  "non-string input returns empty string through index — never throws",
  () => {
    assert.strictEqual(utils.maskUserIdentifier(null),      "");
    assert.strictEqual(utils.maskUserIdentifier(undefined), "");
    assert.strictEqual(utils.maskUserIdentifier(42),        "");
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Unified utils entry point fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
