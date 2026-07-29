"use strict";

/**
 * Canonical unit test for src/api/consent.js
 *
 * Directly imports and exercises the production consent action handler.
 * No mocks, no stubs, no simulation — every assertion drives the real
 * handleConsentAction() code path.
 *
 * Proves:
 *   1. Unsupported HTTP methods (GET, PUT, DELETE, PATCH) are intercepted
 *      and return a 405 Method Not Allowed response without throwing.
 *   2. The 405 body names the set of allowed methods so API clients can
 *      self-correct.
 *   3. Valid POST payloads are accepted (200).
 *   4. Structurally invalid POST bodies are rejected (400) with a reason.
 *   5. The handler is safe against null / undefined / missing inputs.
 *
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { handleConsentAction, ALLOWED_METHODS } = require("./consent");

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
const VALID_BODY = {
  userId:          "usr_hushh_2026",
  requestId:       "req_consent_abc123",
  vaultOwnerToken: "hushh_consent:vault.owner.sig",
};

// ── Suite 1: Unsupported method interception ──────────────────────────────────

console.log("\n[Suite 1] Unsupported HTTP methods → 405 Method Not Allowed");

runTest(
  "GET request is intercepted and returns statusCode 405",
  () => {
    const result = handleConsentAction({ method: "GET", body: VALID_BODY });
    assert.strictEqual(result.statusCode, 405,
      "GET must be rejected with 405 — production route exposes no GET handler");
  }
);

runTest(
  "PUT request returns 405 without throwing",
  () => {
    const result = handleConsentAction({ method: "PUT", body: VALID_BODY });
    assert.strictEqual(result.statusCode, 405);
  }
);

runTest(
  "DELETE request returns 405 without throwing",
  () => {
    const result = handleConsentAction({ method: "DELETE", body: VALID_BODY });
    assert.strictEqual(result.statusCode, 405);
  }
);

runTest(
  "PATCH request returns 405 without throwing",
  () => {
    const result = handleConsentAction({ method: "PATCH", body: VALID_BODY });
    assert.strictEqual(result.statusCode, 405);
  }
);

runTest(
  "405 body names the set of allowed methods so clients can self-correct",
  () => {
    const result = handleConsentAction({ method: "GET", body: VALID_BODY });
    assert.ok(
      Array.isArray(result.body.allowed),
      "allowed field must be an array"
    );
    assert.ok(
      result.body.allowed.includes("POST"),
      `'POST' must appear in allowed list. Got: ${JSON.stringify(result.body.allowed)}`
    );
  }
);

runTest(
  "405 body contains an error string",
  () => {
    const result = handleConsentAction({ method: "DELETE" });
    assert.ok(
      typeof result.body.error === "string" && result.body.error.length > 0,
      "error field must be a non-empty string"
    );
  }
);

runTest(
  "method matching is case-insensitive — lowercase 'get' also returns 405",
  () => {
    const result = handleConsentAction({ method: "get", body: VALID_BODY });
    assert.strictEqual(result.statusCode, 405);
  }
);

// ── Suite 2: ALLOWED_METHODS registry integrity ───────────────────────────────

console.log("\n[Suite 2] ALLOWED_METHODS registry — exported Set is well-formed");

runTest(
  "ALLOWED_METHODS is exported as a Set",
  () => assert.ok(ALLOWED_METHODS instanceof Set, "ALLOWED_METHODS must be a Set")
);

runTest(
  "POST is the only allowed method for consent actions",
  () => {
    assert.ok(ALLOWED_METHODS.has("POST"), "POST must be in ALLOWED_METHODS");
    assert.strictEqual(ALLOWED_METHODS.size, 1,
      "Only POST should be authorised — consent actions are mutation-only operations");
  }
);

// ── Suite 3: Valid POST payload — production path accepts and forwards ─────────

console.log("\n[Suite 3] Valid POST payload → 200 accepted");

runTest(
  "POST with valid consent action body returns statusCode 200",
  () => {
    const result = handleConsentAction({ method: "POST", body: VALID_BODY });
    assert.strictEqual(result.statusCode, 200,
      `Expected 200, got ${result.statusCode}. body: ${JSON.stringify(result.body)}`);
  }
);

runTest(
  "200 response body confirms acceptance",
  () => {
    const result = handleConsentAction({ method: "POST", body: VALID_BODY });
    assert.strictEqual(result.body.accepted, true);
  }
);

// ── Suite 4: Invalid POST body — field validation rejects bad structure ────────

console.log("\n[Suite 4] Invalid POST payloads → 400 with named field error");

runTest(
  "POST missing userId returns 400 — mirrors pending/deny/route.ts if (!userId) → 400",
  () => {
    const result = handleConsentAction({
      method: "POST",
      body: { requestId: "req_abc", vaultOwnerToken: "hushh_consent:vault.sig" },
    });
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.error.toLowerCase().includes("userid"),
      `Error must name userId. Got: "${result.body.error}"`);
  }
);

runTest(
  "POST missing requestId returns 400 — mirrors pending/deny/route.ts guard",
  () => {
    const result = handleConsentAction({
      method: "POST",
      body: { userId: "usr_test", vaultOwnerToken: "hushh_consent:vault.sig" },
    });
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.error.toLowerCase().includes("requestid"));
  }
);

runTest(
  "POST missing vaultOwnerToken returns 400 — mirrors api-service.ts guard",
  () => {
    const result = handleConsentAction({
      method: "POST",
      body: { userId: "usr_test", requestId: "req_abc" },
    });
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.error.toLowerCase().includes("vaultownertoken"));
  }
);

runTest(
  "POST with exportKey present returns 400 — ZK mode guard (pending/approve/route.ts)",
  () => {
    const result = handleConsentAction({
      method: "POST",
      body: { ...VALID_BODY, exportKey: "plaintext-secret" },
    });
    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.body.error.toLowerCase().includes("exportkey"),
      `Error must reference exportKey. Got: "${result.body.error}"`);
  }
);

runTest(
  "POST with non-object body returns 400 without throwing",
  () => {
    const result = handleConsentAction({ method: "POST", body: "invalid" });
    assert.strictEqual(result.statusCode, 400);
  }
);

// ── Suite 5: Structural safety — null / missing request inputs ────────────────

console.log("\n[Suite 5] Structural safety — null / missing req inputs");

runTest(
  "null request object returns 405 (method defaults to empty string) without throwing",
  () => {
    const result = handleConsentAction(null);
    assert.strictEqual(result.statusCode, 405,
      "null request must not throw — method defaults to '' which is not in ALLOWED_METHODS");
  }
);

runTest(
  "undefined request returns 405 without throwing",
  () => {
    const result = handleConsentAction(undefined);
    assert.strictEqual(result.statusCode, 405);
  }
);

runTest(
  "request with no method property returns 405 without throwing",
  () => {
    const result = handleConsentAction({ body: VALID_BODY });
    assert.strictEqual(result.statusCode, 405);
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent API handler contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
