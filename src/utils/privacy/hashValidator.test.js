"use strict";

/**
 * Canonical unit test for src/utils/privacy/hashValidator.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { isValidHexHash } = require("./hashValidator");

// ── Reference hashes used across suites ───────────────────────────────────────

// 64-char SHA-256 style — lowercase
const SHA256_LOWER =
  "a3f2e1b0c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1";

// Same hash — uppercase
const SHA256_UPPER =
  "A3F2E1B0C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1";

// 40-char SHA-1 style
const SHA1_LOWER  = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

// 32-char MD5 style
const MD5_LOWER   = "d41d8cd98f00b204e9800998ecf8427e";

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

// ── Suite 1: Standard valid 64-character SHA-256 hex strings ──────────────────

console.log("\n[Suite 1] Standard valid 64-character SHA-256 hex strings");

runTest(
  "real-world 64-char lowercase SHA-256 hash is valid",
  () => assert.strictEqual(isValidHexHash(SHA256_LOWER), true)
);

runTest(
  "real-world 64-char uppercase SHA-256 hash is valid",
  () => assert.strictEqual(isValidHexHash(SHA256_UPPER), true)
);

runTest(
  "64-char all-zero string is a valid hex hash",
  () => assert.strictEqual(isValidHexHash("0".repeat(64)), true)
);

runTest(
  "64-char all-lowercase-f string is a valid hex hash",
  () => assert.strictEqual(isValidHexHash("f".repeat(64)), true)
);

runTest(
  "64-char all-uppercase-F string is a valid hex hash",
  () => assert.strictEqual(isValidHexHash("F".repeat(64)), true)
);

runTest(
  "64-char string using all 16 distinct hex digits (0-9 and a-f) is valid",
  () => {
    const allHexDigits = "0123456789abcdef".repeat(4); // 64 chars
    assert.strictEqual(isValidHexHash(allHexDigits), true);
  }
);

// ── Suite 2: Case-insensitivity — upper and lower hex accepted equally ────────

console.log("\n[Suite 2] Case-insensitivity — upper and lower case hex accepted");

runTest(
  "fully lowercase hex string (0-9, a-f) returns true",
  () => {
    const lower = "abcdef0123456789".repeat(4); // 64 chars, all lower
    assert.strictEqual(isValidHexHash(lower), true);
  }
);

runTest(
  "fully uppercase hex string (0-9, A-F) returns true",
  () => {
    const upper = "ABCDEF0123456789".repeat(4); // 64 chars, all upper
    assert.strictEqual(isValidHexHash(upper), true);
  }
);

runTest(
  "mixed-case hex string alternating upper and lower returns true",
  () => {
    // Alternating: "aAbBcCdD..." pattern, 64 chars
    const mixed = "aAbBcCdDeEfF0123".repeat(4);
    assert.strictEqual(isValidHexHash(mixed), true);
  }
);

runTest(
  "uppercase A-F characters are treated as valid without any normalisation",
  () => {
    const upperLettersOnly = ("AB".repeat(32)); // 64 chars, only A and B
    assert.strictEqual(isValidHexHash(upperLettersOnly), true);
  }
);

// ── Suite 3: Non-hex characters → false ──────────────────────────────────────

console.log("\n[Suite 3] Invalid non-hex characters — must return false");

runTest(
  "hash containing letter 'g' (outside a-f range) returns false",
  () => {
    const withG = "g" + "a".repeat(63);
    assert.strictEqual(isValidHexHash(withG), false);
  }
);

runTest(
  "hash containing letter 'z' returns false",
  () => {
    const withZ = "a".repeat(63) + "z";
    assert.strictEqual(isValidHexHash(withZ), false);
  }
);

runTest(
  "hash containing an internal space character returns false",
  () => {
    const withSpace = "a".repeat(32) + " " + "b".repeat(31);
    assert.strictEqual(isValidHexHash(withSpace), false);
  }
);

runTest(
  "'0x'-prefixed hex string returns false (prefix is not a hex char)",
  () => {
    const withPrefix = "0x" + "a".repeat(62); // 64 chars but 'x' is invalid
    assert.strictEqual(isValidHexHash(withPrefix), false);
  }
);

runTest(
  "hash containing a hyphen separator returns false",
  () => {
    const withHyphen = "a".repeat(31) + "-" + "b".repeat(32);
    assert.strictEqual(isValidHexHash(withHyphen), false);
  }
);

runTest(
  "hash containing a special character '@' returns false",
  () => {
    const withAt = "@" + "f".repeat(63);
    assert.strictEqual(isValidHexHash(withAt), false);
  }
);

runTest(
  "hash containing an uppercase non-hex letter 'G' returns false",
  () => {
    const withG = "G" + "A".repeat(63);
    assert.strictEqual(isValidHexHash(withG), false);
  }
);

// ── Suite 4: Incorrect length boundaries → false ─────────────────────────────

console.log("\n[Suite 4] Incorrect length boundaries — must return false");

runTest(
  "63-char hex string (one short of 64) returns false",
  () => assert.strictEqual(isValidHexHash("a".repeat(63)), false)
);

runTest(
  "65-char hex string (one over 64) returns false",
  () => assert.strictEqual(isValidHexHash("a".repeat(65)), false)
);

runTest(
  "empty string returns false",
  () => assert.strictEqual(isValidHexHash(""), false)
);

runTest(
  "SHA-1 hash (40 chars) fails default 64-char length check",
  () => assert.strictEqual(isValidHexHash(SHA1_LOWER), false)
);

runTest(
  "MD5 hash (32 chars) passes when expectedLength is 32",
  () => assert.strictEqual(isValidHexHash(MD5_LOWER, 32), true)
);

runTest(
  "SHA-1 hash (40 chars) passes when expectedLength is 40",
  () => assert.strictEqual(isValidHexHash(SHA1_LOWER, 40), true)
);

runTest(
  "valid hex content but wrong custom length returns false",
  () => {
    // 64-char valid hash checked against length 32 — should fail
    assert.strictEqual(isValidHexHash(SHA256_LOWER, 32), false);
  }
);

runTest(
  "expectedLength = 0 returns false (invalid boundary)",
  () => assert.strictEqual(isValidHexHash("a".repeat(0), 0), false)
);

runTest(
  "expectedLength = -1 (negative) returns false",
  () => assert.strictEqual(isValidHexHash("a".repeat(64), -1), false)
);

// ── Suite 5: Type-safety — non-string hashString and invalid expectedLength ───

console.log("\n[Suite 5] Type-safety — non-string inputs and invalid expectedLength values");

runTest(
  "null hashString returns false without throwing",
  () => assert.strictEqual(isValidHexHash(null), false)
);

runTest(
  "undefined hashString returns false without throwing",
  () => assert.strictEqual(isValidHexHash(undefined), false)
);

runTest(
  "numeric hashString returns false without throwing",
  () => assert.strictEqual(isValidHexHash(12345678901234567890), false)
);

runTest(
  "boolean hashString returns false without throwing",
  () => assert.strictEqual(isValidHexHash(true), false)
);

runTest(
  "array of hex chars returns false without throwing",
  () => assert.strictEqual(isValidHexHash(["a", "b", "c"]), false)
);

runTest(
  "object hashString returns false without throwing",
  () => assert.strictEqual(isValidHexHash({ hash: SHA256_LOWER }), false)
);

runTest(
  "expectedLength = NaN returns false",
  () => assert.strictEqual(isValidHexHash("a".repeat(64), NaN), false)
);

runTest(
  "expectedLength = Infinity returns false (non-finite)",
  () => assert.strictEqual(isValidHexHash("a".repeat(64), Infinity), false)
);

runTest(
  'expectedLength = "64" (string) returns false — must be a number',
  () => assert.strictEqual(isValidHexHash(SHA256_LOWER, "64"), false)
);

runTest(
  "expectedLength = 64.5 (float) returns false — must be an integer",
  () => assert.strictEqual(isValidHexHash(SHA256_LOWER, 64.5), false)
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Hex hash validation contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
