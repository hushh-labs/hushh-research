"use strict";

/**
 * Canonical unit test for src/utils/consent/payloadValidator.js
 *
 * Proves that validateConsentPayload enforces the same structural guards
 * already present across the consent-action call path:
 *
 *   hushh-webapp/lib/services/api-service.ts
 *     approvePendingConsent / denyPendingConsent
 *   hushh-webapp/app/api/consent/pending/deny/route.ts     → 400 on missing userId/requestId
 *   hushh-webapp/app/api/consent/pending/approve/route.ts  → 400 on missing userId/requestId
 *                                                          → 400 on exportKey (ZK mode)
 *   api-service.ts                                         → 401 on missing vaultOwnerToken
 *   consent-protocol/api/routes/consent.py
 *     CancelConsentRequest (Pydantic): userId: str, requestId: str
 *
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { validateConsentPayload } = require("./payloadValidator");

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

// Reference payload matching the real denyPendingConsent / approvePendingConsent shape
const VALID_DENY_PAYLOAD = {
  userId:          "usr_abdulgaffar_2026",
  requestId:       "req_consent_abc123",
  vaultOwnerToken: "hushh_consent:vault.abc.sig123",
};

// ── Suite 1: Valid consent action payload ─────────────────────────────────────

console.log("\n[Suite 1] Valid consent action payload — matches real denyPendingConsent shape");

runTest(
  "fully valid payload returns { valid: true }",
  () => {
    const result = validateConsentPayload(VALID_DENY_PAYLOAD);
    assert.strictEqual(result.valid, true,
      `Expected valid:true — mirrors 200 path in pending/deny/route.ts. Got: ${JSON.stringify(result)}`);
  }
);

runTest(
  "sanitized property references the original payload object",
  () => {
    const result = validateConsentPayload(VALID_DENY_PAYLOAD);
    assert.strictEqual(result.sanitized, VALID_DENY_PAYLOAD,
      "sanitized must be the same object reference as the input payload");
  }
);

runTest(
  "valid result carries no error property",
  () => {
    const result = validateConsentPayload(VALID_DENY_PAYLOAD);
    assert.strictEqual(result.error, undefined);
  }
);

runTest(
  "extra optional fields (encryptedData, durationHours) are preserved for approve path",
  () => {
    const approvePayload = {
      ...VALID_DENY_PAYLOAD,
      encryptedData:  "enc_base64_payload",
      encryptedIv:    "iv_base64",
      durationHours:  24,
    };
    const result = validateConsentPayload(approvePayload);
    assert.strictEqual(result.valid, true,
      "Optional approve-path fields must not cause validation failure");
  }
);

// ── Suite 2: Missing required fields ─────────────────────────────────────────

console.log("\n[Suite 2] Missing required fields — mirrors 400 guards in the JS route handlers");

runTest(
  "missing userId → valid:false (mirrors: pending/deny/route.ts if (!userId) → 400)",
  () => {
    const result = validateConsentPayload({
      requestId:       "req_abc",
      vaultOwnerToken: "hushh_consent:vault.abc.sig",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"),
      `Error must name the missing field. Got: "${result.error}"`);
  }
);

runTest(
  "missing requestId → valid:false (mirrors: pending/deny/route.ts if (!requestId) → 400)",
  () => {
    const result = validateConsentPayload({
      userId:          "usr_test",
      vaultOwnerToken: "hushh_consent:vault.abc.sig",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("requestid"),
      `Error must name the missing field. Got: "${result.error}"`);
  }
);

runTest(
  "missing vaultOwnerToken → valid:false (mirrors: api-service.ts if (!vaultOwnerToken) → 401)",
  () => {
    const result = validateConsentPayload({
      userId:    "usr_test",
      requestId: "req_abc",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("vaultownertoken"),
      `Error must name the missing field. Got: "${result.error}"`);
  }
);

runTest(
  "empty object → valid:false, reports first missing field",
  () => {
    const result = validateConsentPayload({});
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
  }
);

// ── Suite 3: Type and format violations ───────────────────────────────────────

console.log("\n[Suite 3] Type and format violations — same conditions the Python Pydantic models enforce");

runTest(
  "userId as number → valid:false (Python CancelConsentRequest: userId: str)",
  () => {
    const result = validateConsentPayload({ ...VALID_DENY_PAYLOAD, userId: 42 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"));
  }
);

runTest(
  "userId as empty string → valid:false",
  () => {
    const result = validateConsentPayload({ ...VALID_DENY_PAYLOAD, userId: "   " });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"));
  }
);

runTest(
  "requestId as number → valid:false (Python CancelConsentRequest: requestId: str)",
  () => {
    const result = validateConsentPayload({ ...VALID_DENY_PAYLOAD, requestId: 99 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("requestid"));
  }
);

runTest(
  "requestId as empty string → valid:false",
  () => {
    const result = validateConsentPayload({ ...VALID_DENY_PAYLOAD, requestId: "" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("requestid"));
  }
);

runTest(
  "vaultOwnerToken as whitespace-only string → valid:false",
  () => {
    const result = validateConsentPayload({ ...VALID_DENY_PAYLOAD, vaultOwnerToken: "   " });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("vaultownertoken"));
  }
);

// ── Suite 4: Zero-knowledge mode guard ────────────────────────────────────────

console.log("\n[Suite 4] ZK mode guard — mirrors pending/approve/route.ts exportKey → 400");

runTest(
  "payload containing exportKey → valid:false regardless of other fields",
  () => {
    const result = validateConsentPayload({
      ...VALID_DENY_PAYLOAD,
      exportKey: "plaintext-key-value",
    });
    assert.strictEqual(result.valid, false,
      "exportKey violates the zero-knowledge contract (approve/route.ts returns 400 for this)");
    assert.ok(result.error.toLowerCase().includes("exportkey"),
      `Error must reference exportKey. Got: "${result.error}"`);
  }
);

runTest(
  "payload with exportKey = null still triggers ZK guard (key presence, not value)",
  () => {
    const result = validateConsentPayload({ ...VALID_DENY_PAYLOAD, exportKey: null });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("exportkey"));
  }
);

// ── Suite 5: Structural integrity — invalid top-level input types ─────────────

console.log("\n[Suite 5] Structural integrity — invalid top-level input types");

runTest(
  "null payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(null);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

runTest(
  "undefined payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(undefined);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

runTest(
  "array payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(["usr", "req", "tok"]);
    assert.strictEqual(result.valid, false);
  }
);

runTest(
  "string payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload("userId=abc&requestId=req");
    assert.strictEqual(result.valid, false);
  }
);

runTest(
  "numeric payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(42);
    assert.strictEqual(result.valid, false);
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent action payload validation contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
