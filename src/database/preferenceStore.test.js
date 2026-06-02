"use strict";

/**
 * Canonical unit test for src/database/preferenceStore.js
 *
 * Directly imports and exercises the production preference storage adapter.
 * No mocks of the module under test — every assertion drives the real
 * storePreference() and validatePayload() code paths.
 *
 * Reference contract: hushh-webapp/lib/db.ts → storeUserData()
 *   "returns true on success, false on failure (caller decides how to handle)"
 *
 * The adapter NEVER throws. The suites below force every failure mode —
 * bad token, corrupted payload fields, connection refusal, HTTP 503,
 * database engine crash, non-Error throws — and assert the application
 * layer receives a clean false rather than an unhandled exception.
 *
 * Transport injection: options.transport is the production module's own
 * dependency-injection seam.  Supplying a failing transport is NOT a mock
 * of the module under test — it is the documented way to exercise
 * Phase-2 error paths without a live database or network.
 *
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { storePreference, validatePayload } = require("./preferenceStore");

// ── Fixtures ───────────────────────────────────────────────────────────────────

const VALID_PAYLOAD = {
  userId:     "usr_hushh_2026",
  domain:     "preferences",
  ciphertext: "AES-GCM-ciphertext-base64",
  iv:         "init-vector-base64",
  tag:        "auth-tag-base64",
};

const VALID_TOKEN = "hushh_consent:vault.owner.sig";

// Transports that simulate real storage failure modes
const resolveTransport         = async () => ({ success: true });
const connectionRefused        = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); };
const httpServiceUnavailable   = async () => { throw new Error("Storage write failed: HTTP 503 — Service Unavailable"); };
const dbRelationMissing        = async () => { throw new Error('relation "vault.preferences" does not exist'); };
const nonErrorThrow            = async () => { throw "FATAL: storage engine offline"; };  // eslint-disable-line no-throw-literal

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

async function runAsync(label, fn) {
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

// ── Suite 1: validatePayload — field validation (pure in-process, no I/O) ─────

console.log("\n[Suite 1] validatePayload — payload field validation (no I/O)");

runTest(
  "valid payload returns { valid: true }",
  () => {
    const r = validatePayload(VALID_PAYLOAD);
    assert.strictEqual(r.valid, true, `Expected valid:true — got ${JSON.stringify(r)}`);
  }
);

runTest(
  "null payload returns { valid: false }",
  () => assert.strictEqual(validatePayload(null).valid, false)
);

runTest(
  "array payload returns { valid: false }",
  () => assert.strictEqual(validatePayload([]).valid, false)
);

runTest(
  "string payload returns { valid: false }",
  () => assert.strictEqual(validatePayload("invalid").valid, false)
);

runTest(
  "missing userId → { valid: false } naming the field",
  () => {
    const { userId: _, ...rest } = VALID_PAYLOAD;
    const r = validatePayload(rest);
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes("userId"), `error must name userId, got: "${r.error}"`);
  }
);

runTest(
  "empty string userId → { valid: false }",
  () => {
    const r = validatePayload({ ...VALID_PAYLOAD, userId: "   " });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes("userId"));
  }
);

runTest(
  "missing domain → { valid: false }",
  () => {
    const { domain: _, ...rest } = VALID_PAYLOAD;
    assert.strictEqual(validatePayload(rest).valid, false);
  }
);

runTest(
  "missing ciphertext → { valid: false }",
  () => {
    const r = validatePayload({ ...VALID_PAYLOAD, ciphertext: "" });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes("ciphertext"));
  }
);

runTest(
  "missing iv → { valid: false }",
  () => assert.strictEqual(validatePayload({ ...VALID_PAYLOAD, iv: null }).valid, false)
);

runTest(
  "missing tag → { valid: false }",
  () => assert.strictEqual(validatePayload({ ...VALID_PAYLOAD, tag: undefined }).valid, false)
);

// ── Suite 2 & 3 run async — wrapped in an IIFE ────────────────────────────────

(async () => {

// ── Suite 2: Phase-1 token guard — no I/O reaches the transport ───────────────

console.log("\n[Suite 2] storePreference — phase-1 token guard (write never reaches I/O)");

await runAsync(
  "missing vaultOwnerToken → false; transport NOT called",
  async () => {
    let called = false;
    const spy  = async () => { called = true; };
    const r    = await storePreference(VALID_PAYLOAD, { transport: spy });
    assert.strictEqual(r, false, "Missing token must return false immediately");
    assert.strictEqual(called, false, "Transport must NOT be invoked when token is absent");
  }
);

await runAsync(
  "whitespace-only vaultOwnerToken → false",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, { vaultOwnerToken: "   ", transport: resolveTransport });
    assert.strictEqual(r, false);
  }
);

await runAsync(
  "null vaultOwnerToken → false without throwing",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, { vaultOwnerToken: null, transport: resolveTransport });
    assert.strictEqual(r, false);
  }
);

// ── Suite 3: Phase-1 payload guard — bad payload returns false before I/O ──────

console.log("\n[Suite 3] storePreference — phase-1 payload guard (transport never reached)");

await runAsync(
  "null payload → false; transport NOT called",
  async () => {
    let called = false;
    const spy  = async () => { called = true; };
    const r    = await storePreference(null, { vaultOwnerToken: VALID_TOKEN, transport: spy });
    assert.strictEqual(r, false);
    assert.strictEqual(called, false, "Transport must NOT be invoked for a null payload");
  }
);

await runAsync(
  "payload with numeric userId → false (storage contract violation)",
  async () => {
    const r = await storePreference(
      { ...VALID_PAYLOAD, userId: 42 },
      { vaultOwnerToken: VALID_TOKEN, transport: resolveTransport }
    );
    assert.strictEqual(r, false);
  }
);

await runAsync(
  "payload with empty ciphertext → false (invalid AES-GCM component)",
  async () => {
    const r = await storePreference(
      { ...VALID_PAYLOAD, ciphertext: "" },
      { vaultOwnerToken: VALID_TOKEN, transport: resolveTransport }
    );
    assert.strictEqual(r, false);
  }
);

await runAsync(
  "payload with null iv → false (uninitialized encryption field)",
  async () => {
    const r = await storePreference(
      { ...VALID_PAYLOAD, iv: null },
      { vaultOwnerToken: VALID_TOKEN, transport: resolveTransport }
    );
    assert.strictEqual(r, false);
  }
);

// ── Suite 4: Phase-2 storage violations — transport errors absorbed cleanly ────

console.log("\n[Suite 4] storePreference — phase-2 storage violations (errors absorbed)");

await runAsync(
  "ECONNREFUSED (database unreachable) → false, application does not crash",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: connectionRefused,
    });
    assert.strictEqual(r, false,
      "Connection-refused error must be absorbed — application layer must not crash");
  }
);

await runAsync(
  "HTTP 503 Service Unavailable → false, application does not crash",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: httpServiceUnavailable,
    });
    assert.strictEqual(r, false);
  }
);

await runAsync(
  "database engine crash (missing relation) → false, never propagated",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: dbRelationMissing,
    });
    assert.strictEqual(r, false,
      "DB engine error must be caught and absorbed — error must not surface to caller");
  }
);

await runAsync(
  "non-Error thrown object (string) → false, handler is safe",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: nonErrorThrow,
    });
    assert.strictEqual(r, false);
  }
);

// ── Suite 5: Happy path and body shape verification ───────────────────────────

console.log("\n[Suite 5] storePreference — happy path and encrypted-blob body shape");

await runAsync(
  "valid payload + working transport → true",
  async () => {
    const r = await storePreference(VALID_PAYLOAD, {
      vaultOwnerToken: VALID_TOKEN,
      transport: resolveTransport,
    });
    assert.strictEqual(r, true, "Valid payload with working transport must return true");
  }
);

await runAsync(
  "transport receives correctly shaped AES-GCM encrypted-blob body",
  async () => {
    let captured = null;
    const spy    = async ({ body }) => { captured = body; };

    await storePreference(VALID_PAYLOAD, { vaultOwnerToken: VALID_TOKEN, transport: spy });

    assert.strictEqual(captured.user_id, VALID_PAYLOAD.userId,
      "user_id must be mapped from userId");
    assert.strictEqual(captured.domain, VALID_PAYLOAD.domain);
    assert.strictEqual(captured.encrypted_blob.ciphertext, VALID_PAYLOAD.ciphertext);
    assert.strictEqual(captured.encrypted_blob.iv,         VALID_PAYLOAD.iv);
    assert.strictEqual(captured.encrypted_blob.tag,        VALID_PAYLOAD.tag);
    assert.strictEqual(captured.encrypted_blob.algorithm,  "aes-256-gcm",
      "Algorithm constant must match what the PKM backend expects");
    assert.deepStrictEqual(captured.summary, {},
      "summary must be an empty object — preference blobs are not queryable PKM data");
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
