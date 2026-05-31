"use strict";

/**
 * Canonical unit test for src/utils/privacy/tokenTruncator.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { truncateDataToken } = require("./tokenTruncator");

// Known constants — kept in the test to avoid importing internals
const SUFFIX        = "...[TRUNCATED]";
const SUFFIX_LEN    = SUFFIX.length;           // 14
const DEFAULT_LIMIT = 512;

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

// ── Suite 1: Standard compliant tokens (within default 512-char ceiling) ──────

console.log("\n[Suite 1] Standard compliant tokens — within default ceiling");

runTest(
  "short token returned completely unmodified",
  () => {
    const token  = "tok_usr_abc123_session_xyz";
    const result = truncateDataToken(token);
    assert.strictEqual(result, token, "Short token must be returned byte-for-byte");
  }
);

runTest(
  "token exactly 512 characters is returned unmodified",
  () => {
    const token  = "x".repeat(DEFAULT_LIMIT);
    const result = truncateDataToken(token);
    assert.strictEqual(result.length, DEFAULT_LIMIT);
    assert.strictEqual(result, token, "Exact-boundary token must not be truncated");
  }
);

runTest(
  "token 511 characters (one under ceiling) is returned unmodified",
  () => {
    const token  = "a".repeat(DEFAULT_LIMIT - 1);
    const result = truncateDataToken(token);
    assert.strictEqual(result, token);
  }
);

runTest(
  "empty string is returned unchanged for any positive maxLength",
  () => {
    assert.strictEqual(truncateDataToken("", 512), "");
    assert.strictEqual(truncateDataToken("", 10), "");
    assert.strictEqual(truncateDataToken("", 1), "");
  }
);

// ── Suite 2: Oversized token — truncation and suffix insertion ────────────────

console.log("\n[Suite 2] Oversized tokens — truncation with suffix");

runTest(
  "token 513 chars (one over ceiling) is truncated to exactly 512",
  () => {
    const token  = "b".repeat(DEFAULT_LIMIT + 1);
    const result = truncateDataToken(token);
    assert.strictEqual(result.length, DEFAULT_LIMIT,
      `Expected length ${DEFAULT_LIMIT}, got ${result.length}`);
  }
);

runTest(
  "truncated result ends with the TRUNCATED suffix",
  () => {
    const token  = "c".repeat(DEFAULT_LIMIT + 100);
    const result = truncateDataToken(token);
    assert.ok(
      result.endsWith(SUFFIX),
      `Expected result to end with "${SUFFIX}", got: "${result.slice(-20)}"`
    );
  }
);

runTest(
  "payload body before suffix has correct length (maxLength - suffix length)",
  () => {
    const token  = "d".repeat(DEFAULT_LIMIT + 200);
    const result = truncateDataToken(token);
    const body   = result.slice(0, result.length - SUFFIX_LEN);
    assert.strictEqual(body.length, DEFAULT_LIMIT - SUFFIX_LEN,
      "Body slice must be exactly maxLength - suffixLen characters");
  }
);

runTest(
  "body slice is the leading characters of the original token",
  () => {
    const token  = "e".repeat(DEFAULT_LIMIT + 50);
    const result = truncateDataToken(token);
    const expectedBody = token.slice(0, DEFAULT_LIMIT - SUFFIX_LEN);
    assert.strictEqual(result, expectedBody + SUFFIX);
  }
);

runTest(
  "very large token (10 000 chars) is clamped to exactly 512",
  () => {
    const token  = "f".repeat(10_000);
    const result = truncateDataToken(token);
    assert.strictEqual(result.length, DEFAULT_LIMIT);
    assert.ok(result.endsWith(SUFFIX));
  }
);

// ── Suite 3: Custom maxLength threshold ───────────────────────────────────────

console.log("\n[Suite 3] Custom maxLength thresholds");

runTest(
  "token within custom ceiling is returned unmodified",
  () => {
    const token  = "g".repeat(30);
    const result = truncateDataToken(token, 50);
    assert.strictEqual(result, token, "30-char token within 50-char limit must not be touched");
  }
);

runTest(
  "token exactly at custom ceiling is returned unmodified",
  () => {
    const token  = "h".repeat(100);
    const result = truncateDataToken(token, 100);
    assert.strictEqual(result, token);
  }
);

runTest(
  "custom maxLength=50, token=100 → result exactly 50 chars with suffix",
  () => {
    const token  = "i".repeat(100);
    const result = truncateDataToken(token, 50);
    assert.strictEqual(result.length, 50);
    assert.ok(result.endsWith(SUFFIX));
  }
);

runTest(
  "custom maxLength=200, token=500 → result exactly 200 chars with suffix",
  () => {
    const token  = "j".repeat(500);
    const result = truncateDataToken(token, 200);
    assert.strictEqual(result.length, 200);
    assert.ok(result.endsWith(SUFFIX));
  }
);

runTest(
  "float maxLength is floored before comparison (50.9 behaves as 50)",
  () => {
    const token  = "k".repeat(100);
    const result = truncateDataToken(token, 50.9);
    assert.strictEqual(result.length, 50,
      "Float maxLength must be floored to 50 before application");
    assert.ok(result.endsWith(SUFFIX));
  }
);

runTest(
  "maxLength smaller than suffix length falls back to hard truncation (no suffix)",
  () => {
    const token  = "l".repeat(50);
    const result = truncateDataToken(token, 5);  // 5 < 14 (SUFFIX_LEN)
    assert.strictEqual(result.length, 5,
      "When ceiling < suffix length, hard-truncate without appending suffix");
    assert.strictEqual(result, token.slice(0, 5));
    assert.strictEqual(result.includes("[TRUNCATED]"), false);
  }
);

// ── Suite 4: Type-safety handling — undefined, numeric, and invalid inputs ────

console.log("\n[Suite 4] Type-safety — non-string tokens and invalid boundaries");

runTest(
  "undefined tokenString → empty string, no throw",
  () => assert.strictEqual(truncateDataToken(undefined), "")
);

runTest(
  "null tokenString → empty string, no throw",
  () => assert.strictEqual(truncateDataToken(null), "")
);

runTest(
  "numeric tokenString → empty string, no throw",
  () => assert.strictEqual(truncateDataToken(42), "")
);

runTest(
  "boolean tokenString → empty string, no throw",
  () => assert.strictEqual(truncateDataToken(true), "")
);

runTest(
  "object tokenString → empty string, no throw",
  () => assert.strictEqual(truncateDataToken({ token: "abc" }), "")
);

runTest(
  "array tokenString → empty string, no throw",
  () => assert.strictEqual(truncateDataToken(["abc"]), "")
);

runTest(
  "maxLength = 0 → empty string, no throw",
  () => assert.strictEqual(truncateDataToken("valid-token", 0), "")
);

runTest(
  "maxLength = -1 (negative boundary) → empty string, no throw",
  () => assert.strictEqual(truncateDataToken("valid-token", -1), "")
);

runTest(
  "maxLength = NaN → empty string, no throw",
  () => assert.strictEqual(truncateDataToken("valid-token", NaN), "")
);

runTest(
  "maxLength = Infinity → empty string (non-finite boundary rejected), no throw",
  () => assert.strictEqual(truncateDataToken("valid-token", Infinity), "")
);

runTest(
  "maxLength as string → empty string, no throw",
  () => assert.strictEqual(truncateDataToken("valid-token", "512"), "")
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Token truncation boundary contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
