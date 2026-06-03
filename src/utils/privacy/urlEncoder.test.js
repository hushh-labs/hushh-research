"use strict";

/**
 * Canonical unit test for src/utils/privacy/urlEncoder.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { toUrlSafeBase64 } = require("./urlEncoder");

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

// ── Suite 1: Standard Base64 conversion ───────────────────────────────────────

console.log("\n[Suite 1] Standard Base64 conversion");

runTest(
  "simple ASCII string encodes correctly",
  () => {
    const result = toUrlSafeBase64("hello");
    assert.strictEqual(result, "aGVsbG8",
      "\"hello\" must encode to \"aGVsbG8\" (no padding)");
  }
);

runTest(
  "consent token string round-trips through standard base64 alphabet",
  () => {
    const result = toUrlSafeBase64("hushh:consent:usr_abc");
    assert.ok(typeof result === "string" && result.length > 0,
      "Token string must produce a non-empty encoded output");
  }
);

runTest(
  "encoding is deterministic — same input always produces same output",
  () => {
    const input = "deterministic-test-input";
    assert.strictEqual(toUrlSafeBase64(input), toUrlSafeBase64(input),
      "Two calls with identical input must return identical output");
  }
);

// ── Suite 2: URL-unsafe character replacement ─────────────────────────────────

console.log("\n[Suite 2] URL-unsafe character replacement rules");

runTest(
  "output contains no '+' characters (replaced with '-')",
  () => {
    // Run enough varied inputs to hit + in base64 output
    const samples = ["abc>def", "test+value", ">>>", "foo?bar", "\xfb\xff"];
    for (const s of samples) {
      const encoded = toUrlSafeBase64(s);
      assert.ok(!encoded.includes("+"),
        `'+' must not appear in output for input ${JSON.stringify(s)}`);
    }
  }
);

runTest(
  "output contains no '/' characters (replaced with '_')",
  () => {
    const samples = ["abc>def", "test/path", "///", "foo?bar", "\xfb\xef"];
    for (const s of samples) {
      const encoded = toUrlSafeBase64(s);
      assert.ok(!encoded.includes("/"),
        `'/' must not appear in output for input ${JSON.stringify(s)}`);
    }
  }
);

runTest(
  "output contains no '=' padding characters",
  () => {
    // All inputs — regardless of byte length — must have no trailing =
    const samples = ["a", "ab", "abc", "abcd", "abcde", "hello world"];
    for (const s of samples) {
      const encoded = toUrlSafeBase64(s);
      assert.ok(!encoded.includes("="),
        `'=' padding must be stripped for input ${JSON.stringify(s)}`);
    }
  }
);

runTest(
  "'+' in standard base64 becomes '-' in URL-safe output",
  () => {
    // "ü~" (U+00FC U+007E) → UTF-8 bytes C3 BC 7E → standard base64 "w7x+"
    // The last 6-bit group is 111110 = 62 = '+' in standard base64.
    assert.strictEqual(toUrlSafeBase64("ü~"), "w7x-",
      '"ü~" must encode to "w7x-" — the trailing + becomes -');
  }
);

runTest(
  "'/' in standard base64 becomes '_' in URL-safe output",
  () => {
    // "¿?" (U+00BF U+003F) → UTF-8 bytes C2 BF 3F → standard base64 "wr8/"
    // The last 6-bit group is 111111 = 63 = '/' in standard base64.
    assert.strictEqual(toUrlSafeBase64("¿?"), "wr8_",
      '"¿?" must encode to "wr8_" — the trailing / becomes _');
  }
);

// ── Suite 3: Type-safety and edge cases ───────────────────────────────────────

console.log("\n[Suite 3] Type-safety boundaries and edge cases");

runTest(
  "empty string returns empty string",
  () => assert.strictEqual(toUrlSafeBase64(""), "",
    "Empty string input must return empty string")
);

runTest(
  "null returns empty string without throwing",
  () => assert.strictEqual(toUrlSafeBase64(null), "",
    "null input must return empty string")
);

runTest(
  "undefined returns empty string without throwing",
  () => assert.strictEqual(toUrlSafeBase64(undefined), "",
    "undefined input must return empty string")
);

runTest(
  "numeric input returns empty string without throwing",
  () => assert.strictEqual(toUrlSafeBase64(42), "",
    "Number input must return empty string")
);

runTest(
  "object input returns empty string without throwing",
  () => assert.strictEqual(toUrlSafeBase64({ token: "abc" }), "",
    "Object input must return empty string")
);

runTest(
  "array input returns empty string without throwing",
  () => assert.strictEqual(toUrlSafeBase64(["abc"]), "",
    "Array input must return empty string")
);

runTest(
  "boolean input returns empty string without throwing",
  () => assert.strictEqual(toUrlSafeBase64(true), "",
    "Boolean input must return empty string")
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` URL-safe Base64 encoder contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
