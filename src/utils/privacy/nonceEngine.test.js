"use strict";

/**
 * Canonical unit test for src/utils/privacy/nonceEngine.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { generateRequestNonce, BASELINE_BYTE_LENGTH } = require("./nonceEngine");

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

// ── Suite 1: Return type and format ───────────────────────────────────────────

console.log("\n[Suite 1] Return type and hex format verification");

runTest(
  "default call returns a string",
  () => assert.strictEqual(typeof generateRequestNonce(), "string")
);

runTest(
  "output contains only lowercase hex characters [0-9a-f]",
  () => {
    const nonce = generateRequestNonce();
    assert.ok(/^[0-9a-f]+$/.test(nonce),
      `Nonce must be lowercase hex. Got: ${nonce}`);
  }
);

runTest(
  "custom byteLength=8 returns only lowercase hex characters",
  () => {
    const nonce = generateRequestNonce(8);
    assert.ok(/^[0-9a-f]+$/.test(nonce),
      `Nonce must be lowercase hex. Got: ${nonce}`);
  }
);

// ── Suite 2: Correct output length ────────────────────────────────────────────

console.log("\n[Suite 2] Output length = byteLength × 2 (hex encoding)");

runTest(
  "default (16 bytes) → 32 hex characters",
  () => {
    const nonce = generateRequestNonce();
    assert.strictEqual(nonce.length, 32,
      `Default nonce must be 32 chars (16 bytes × 2). Got length: ${nonce.length}`);
  }
);

runTest(
  "byteLength=8 → 16 hex characters",
  () => assert.strictEqual(generateRequestNonce(8).length, 16)
);

runTest(
  "byteLength=32 → 64 hex characters",
  () => assert.strictEqual(generateRequestNonce(32).length, 64)
);

runTest(
  "byteLength=1 → 2 hex characters",
  () => assert.strictEqual(generateRequestNonce(1).length, 2)
);

runTest(
  "byteLength=64 → 128 hex characters",
  () => assert.strictEqual(generateRequestNonce(64).length, 128)
);

runTest(
  "float input 8.9 is floored to 8 → 16 hex characters",
  () => assert.strictEqual(generateRequestNonce(8.9).length, 16)
);

runTest(
  "float input 16.1 is floored to 16 → 32 hex characters",
  () => assert.strictEqual(generateRequestNonce(16.1).length, 32)
);

// ── Suite 3: Fallback boundary compliance ─────────────────────────────────────

console.log("\n[Suite 3] Invalid inputs → fallback to BASELINE_BYTE_LENGTH (16 bytes = 32 chars)");

runTest(
  "BASELINE_BYTE_LENGTH constant equals 16",
  () => assert.strictEqual(BASELINE_BYTE_LENGTH, 16)
);

runTest(
  "byteLength=0 → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(0).length, 32)
);

runTest(
  "byteLength=-1 → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(-1).length, 32)
);

runTest(
  "byteLength=-100 → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(-100).length, 32)
);

runTest(
  "byteLength=NaN → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(NaN).length, 32)
);

runTest(
  "byteLength=Infinity → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(Infinity).length, 32)
);

runTest(
  "byteLength=-Infinity → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(-Infinity).length, 32)
);

runTest(
  "byteLength=null → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(null).length, 32)
);

runTest(
  "byteLength=undefined → fallback → 32 chars (default param)",
  () => assert.strictEqual(generateRequestNonce(undefined).length, 32)
);

runTest(
  "byteLength=\"16\" (string) → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce("16").length, 32)
);

runTest(
  "byteLength=true (boolean) → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(true).length, 32)
);

runTest(
  "byteLength={} (object) → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce({}).length, 32)
);

runTest(
  "byteLength=[] (array) → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce([]).length, 32)
);

runTest(
  "float 0.9 floored to 0 → fallback → 32 chars",
  () => assert.strictEqual(generateRequestNonce(0.9).length, 32)
);

// ── Suite 4: Uniqueness — randomness distribution ─────────────────────────────

console.log("\n[Suite 4] Randomness — consecutive nonces must be unique");

runTest(
  "two consecutive default nonces are different",
  () => {
    const a = generateRequestNonce();
    const b = generateRequestNonce();
    assert.notStrictEqual(a, b,
      "Two consecutive nonces must be different (cryptographic randomness)");
  }
);

runTest(
  "ten consecutive nonces are all unique",
  () => {
    const nonces = Array.from({ length: 10 }, () => generateRequestNonce());
    const unique = new Set(nonces);
    assert.strictEqual(unique.size, 10,
      "All 10 nonces must be distinct");
  }
);

runTest(
  "twenty consecutive 8-byte nonces are all unique",
  () => {
    const nonces = Array.from({ length: 20 }, () => generateRequestNonce(8));
    const unique = new Set(nonces);
    assert.strictEqual(unique.size, 20,
      "All 20 short nonces must be distinct");
  }
);

runTest(
  "nonce does not repeat across different byte-length calls",
  () => {
    const short = generateRequestNonce(8);   // 16 chars
    const long  = generateRequestNonce(32);  // 64 chars
    assert.notStrictEqual(short, long,
      "Nonces of different lengths must differ");
  }
);

// ── Suite 5: Non-empty output guaranteed ─────────────────────────────────────

console.log("\n[Suite 5] Non-empty output guaranteed for any input");

runTest(
  "default call never returns an empty string",
  () => assert.ok(generateRequestNonce().length > 0)
);

runTest(
  "invalid input (null) still returns a non-empty nonce",
  () => assert.ok(generateRequestNonce(null).length > 0)
);

runTest(
  "zero input still returns a non-empty nonce via fallback",
  () => assert.ok(generateRequestNonce(0).length > 0)
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Request nonce engine contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
