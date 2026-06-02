"use strict";

/**
 * Canonical unit test for src/database/preferenceStore.js
 *
 * Directly imports and exercises the production preference storage adapter.
 * No mocks of the module under test — every assertion drives the real
 * storePreference() and validateStorePayload() code paths.
 *
 * Proves the two-phase failure model that mirrors hushh-webapp/lib/db.ts:
 *
 *   Phase 1 — in-process guards (no I/O attempted):
 *     The production code detects missing token and invalid payload fields
 *     before touching the transport, returning false without crashing.
 *
 *   Phase 2 — transport failures (I/O attempted, errors caught):
 *     When the transport layer throws (simulating a connection refusal,
 *     a non-ok HTTP status, or a storage engine rejection) the production
 *     code absorbs the error and returns false, never letting the storage
 *     crash propagate to the application layer.
 *
 * Transport injection: the `options.transport` parameter lets tests supply
 * a failing transport without a live database or network — this is NOT a
 * mock of the module under test, it is the dependency-injection seam the
 * production module itself exposes for exactly this purpose.
 *
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { storePreference, validateStorePayload } = require("./preferenceStore");

// ── Shared fixtures ────────────────────────────────────────────────────────────

const VALID_PAYLOAD = {
  userId:     "usr_hushh_2026",
  domain:     "preferences",
  ciphertext: "base64-ciphertext-payload",
  iv:         "base64-iv-bytes",
  tag:        "base64-auth-tag",
};

const VALID_TOKEN = "hushh_consent:vault.owner.sig";

/** Transport that resolves immediately — proves the happy path. */
const okTransport = async () => ({ success: true });

/** Transport that throws a synchronous error — simulates connection refusal. */
const connectionRefusedTransport = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
};

/** Transport that rejects with a non-ok HTTP status — simulates 503. */
const serviceUnavailableTransport = async () => {
  throw new Error("Storage request failed: HTTP 503 — Service Unavailable");
};

/** Transport that rejects with a storage engine error — simulates a DB crash. */
const dbCrashTransport = async () => {
  throw new Error("relation \"vault.preferences\" does not exist");
};

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

async function runAsyncTest(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    totalPassed++;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    totalFailed++;
  }
}

// ── Suite 1: validateStorePayload — in-process field validation ────────────────

console.log("\n[Suite 1] validateStorePayload — payload field validation (no I/O)");

runTest(
  "valid payload returns { valid: true }",
  () => {
    const result = validateStorePayload(VALID_PAYLOAD);
    assert.strictEqual(result.valid, true,
      `Expected valid:true. Got: ${JSON.stringify(result)}`);
  }
);

runTest(
  "null payload returns { valid: false } without throwing",
  () => {
    const result = validateStorePayload(null);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
  }
);

runTest(
  "array payload returns { valid: false }",
  () => assert.strictEqual(validateStorePayload([]).valid, false)
);

runTest(
  "missing userId returns { valid: false } naming the field",
  () => {
    const { userId: _, ...rest } = VALID_PAYLOAD;
    const result = validateStorePayload(rest);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"),
      `Error must name userId. Got: "${result.error}"`);
  }
);

runTest(
  "empty string userId returns { valid: false }",
  () => {
    const result = validateStorePayload({ ...VALID_PAYLOAD, userId: "   " });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"));
  }
);

runTest(
  "missing domain returns { valid: false }",
  () => {
    const { domain: _, ...rest } = VALID_PAYLOAD;
    assert.strictEqual(validateStorePayload(rest).valid, false);
  }
);

runTest(
  "missing ciphertext returns { valid: false }",
  () => {
    const result = validateStorePayload({ ...VALID_PAYLOAD, ciphertext: "" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("ciphertext"));
  }
);

runTest(
  "missing iv returns { valid: false }",
  () => {
    const result = validateStorePayload({ ...VALID_PAYLOAD, iv: "" });
    assert.strictEqual(result.valid, false);
  }
);

runTest(
  "missing tag returns { valid: false }",
  () => {
    const result = validateStorePayload({ ...VALID_PAYLOAD, tag: null });
    assert.strictEqual(result.valid, false);
  }
);

// ── Suite 2: Phase 1 failures — missing token guard (no I/O) ─────────────────

console.log("\n[Suite 2] storePreference phase-1 — missing vault-owner token guard");

(async () => {

await runAsyncTest(
  "missing vaultOwnerToken returns false — write never reaches transport",
  async () => {
    let transportCalled = false;
    const spy = async () => { transportCalled = true; };

    const result = await storePreference(VALID_PAYLOAD, {
      transport: spy,
      // vaultOwnerToken deliberately omitted
    });

    assert.strictEqual(result, false,
      "Missing token must be caught before any I/O occurs");
    assert.strictEqual(transportCalled, false,
      "Transport must NOT be called when token is absent");
  }
);

await runAsyncTest(
  "empty string vaultOwnerToken returns false",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: "   ",
      transport: okTransport,
    });
    assert.strictEqual(result, false);
  }
);

await runAsyncTest(
  "null vaultOwnerToken returns false without throwing",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: null,
      transport: okTransport,
    });
    assert.strictEqual(result, false);
  }
);

// ── Suite 3: Phase 1 failures — invalid payload guard (no I/O) ───────────────

console.log("\n[Suite 3] storePreference phase-1 — invalid payload guard");

await runAsyncTest(
  "null payload returns false — transport never called",
  async () => {
    let transportCalled = false;
    const spy = async () => { transportCalled = true; };

    const result = await storePreference(null, {
      vaultOwnerToken: VALID_TOKEN,
      transport: spy,
    });
    assert.strictEqual(result, false);
    assert.strictEqual(transportCalled, false,
      "Transport must NOT be invoked for a null payload");
  }
);

await runAsyncTest(
  "payload with missing userId returns false without I/O",
  async () => {
    const { userId: _, ...rest } = VALID_PAYLOAD;
    const result = await storePreference(rest, {
      vaultOwnerToken: VALID_TOKEN,
      transport: okTransport,
    });
    assert.strictEqual(result, false);
  }
);

await runAsyncTest(
  "payload with empty ciphertext returns false without I/O",
  async () => {
    const result = await storePreference(
      { ...VALID_PAYLOAD, ciphertext: "" },
      { vaultOwnerToken: VALID_TOKEN, transport: okTransport }
    );
    assert.strictEqual(result, false);
  }
);

// ── Suite 4: Phase 2 failures — transport errors caught, false returned ───────

console.log("\n[Suite 4] storePreference phase-2 — transport error interception");

await runAsyncTest(
  "ECONNREFUSED (connection refusal) → returns false, never throws",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: connectionRefusedTransport,
    });
    assert.strictEqual(result, false,
      "Connection-refused error must be absorbed — application must not crash");
  }
);

await runAsyncTest(
  "HTTP 503 Service Unavailable → returns false, never throws",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: serviceUnavailableTransport,
    });
    assert.strictEqual(result, false);
  }
);

await runAsyncTest(
  "database engine crash (missing relation) → returns false, never throws",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: dbCrashTransport,
    });
    assert.strictEqual(result, false,
      "DB engine error must be caught — application must not propagate the exception");
  }
);

await runAsyncTest(
  "transport that throws a non-Error object → returns false, never throws",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: async () => { throw "FATAL: storage engine offline"; },
    });
    assert.strictEqual(result, false);
  }
);

// ── Suite 5: Happy path — valid payload and working transport ─────────────────

console.log("\n[Suite 5] storePreference happy path — valid payload and transport");

await runAsyncTest(
  "valid payload and token with working transport returns true",
  async () => {
    const result = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: okTransport,
    });
    assert.strictEqual(result, true,
      "Valid payload with working transport must return true");
  }
);

await runAsyncTest(
  "transport receives correctly shaped encrypted-blob body",
  async () => {
    let capturedBody = null;
    const capturingTransport = async ({ body }) => { capturedBody = body; };

    await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: capturingTransport,
    });

    assert.strictEqual(capturedBody.user_id, VALID_PAYLOAD.userId);
    assert.strictEqual(capturedBody.domain,  VALID_PAYLOAD.domain);
    assert.strictEqual(capturedBody.encrypted_blob.ciphertext, VALID_PAYLOAD.ciphertext);
    assert.strictEqual(capturedBody.encrypted_blob.algorithm,  "aes-256-gcm");
    assert.deepStrictEqual(capturedBody.summary, {});
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Preference store error-handling contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}

})();
