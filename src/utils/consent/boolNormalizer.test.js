"use strict";

/**
 * Canonical unit test for src/utils/consent/boolNormalizer.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { normalizeConsentBool } = require("./boolNormalizer");

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

// ── Suite 1: Native boolean inputs ────────────────────────────────────────────

console.log("\n[Suite 1] Native boolean inputs — pass through exactly");

runTest(
  "true  → true",
  () => assert.strictEqual(normalizeConsentBool(true), true)
);

runTest(
  "false → false",
  () => assert.strictEqual(normalizeConsentBool(false), false)
);

// ── Suite 2: Numeric inputs ────────────────────────────────────────────────────

console.log("\n[Suite 2] Numeric inputs — 1 is affirmative, 0 is denial");

runTest(
  "1  → true",
  () => assert.strictEqual(normalizeConsentBool(1), true)
);

runTest(
  "0  → false",
  () => assert.strictEqual(normalizeConsentBool(0), false)
);

runTest(
  "2  → false (only exact 1 is truthy)",
  () => assert.strictEqual(normalizeConsentBool(2), false)
);

runTest(
  "-1 → false",
  () => assert.strictEqual(normalizeConsentBool(-1), false)
);

runTest(
  "0.5 (float) → false",
  () => assert.strictEqual(normalizeConsentBool(0.5), false)
);

// ── Suite 3: Truthy string tokens → true ──────────────────────────────────────

console.log("\n[Suite 3] Truthy string tokens → true");

runTest(
  '"true"  → true',
  () => assert.strictEqual(normalizeConsentBool("true"), true)
);

runTest(
  '"TRUE"  → true  (case-insensitive)',
  () => assert.strictEqual(normalizeConsentBool("TRUE"), true)
);

runTest(
  '"True"  → true  (mixed case)',
  () => assert.strictEqual(normalizeConsentBool("True"), true)
);

runTest(
  '"on"    → true',
  () => assert.strictEqual(normalizeConsentBool("on"), true)
);

runTest(
  '"ON"    → true  (case-insensitive)',
  () => assert.strictEqual(normalizeConsentBool("ON"), true)
);

runTest(
  '"yes"   → true',
  () => assert.strictEqual(normalizeConsentBool("yes"), true)
);

runTest(
  '"YES"   → true  (case-insensitive)',
  () => assert.strictEqual(normalizeConsentBool("YES"), true)
);

runTest(
  '"1"     → true  (numeric string)',
  () => assert.strictEqual(normalizeConsentBool("1"), true)
);

runTest(
  '"  true  " → true  (leading/trailing whitespace trimmed)',
  () => assert.strictEqual(normalizeConsentBool("  true  "), true)
);

runTest(
  '"  ON  "   → true  (whitespace + case)',
  () => assert.strictEqual(normalizeConsentBool("  ON  "), true)
);

// ── Suite 4: Falsy string tokens → false ──────────────────────────────────────

console.log("\n[Suite 4] Falsy string tokens → false  (secure-default posture)");

runTest(
  '"false" → false',
  () => assert.strictEqual(normalizeConsentBool("false"), false)
);

runTest(
  '"FALSE" → false',
  () => assert.strictEqual(normalizeConsentBool("FALSE"), false)
);

runTest(
  '"off"   → false',
  () => assert.strictEqual(normalizeConsentBool("off"), false)
);

runTest(
  '"no"    → false',
  () => assert.strictEqual(normalizeConsentBool("no"), false)
);

runTest(
  '"0"     → false',
  () => assert.strictEqual(normalizeConsentBool("0"), false)
);

runTest(
  'empty string "" → false',
  () => assert.strictEqual(normalizeConsentBool(""), false)
);

runTest(
  'whitespace-only "   " → false',
  () => assert.strictEqual(normalizeConsentBool("   "), false)
);

runTest(
  '"yes " with trailing space → true  (trimmed before lookup)',
  () => assert.strictEqual(normalizeConsentBool("yes "), true)
);

runTest(
  '"random" unrecognised string → false',
  () => assert.strictEqual(normalizeConsentBool("random"), false)
);

// ── Suite 5: Null and undefined — secure default → false ─────────────────────

console.log("\n[Suite 5] null / undefined → false  (missing consent = no consent)");

runTest(
  "null      → false",
  () => assert.strictEqual(normalizeConsentBool(null), false)
);

runTest(
  "undefined → false",
  () => assert.strictEqual(normalizeConsentBool(undefined), false)
);

// ── Suite 6: Non-string / non-numeric types → false ───────────────────────────

console.log("\n[Suite 6] Objects, arrays, and other exotic types → false");

runTest(
  "object {}          → false",
  () => assert.strictEqual(normalizeConsentBool({}), false)
);

runTest(
  "array [true]       → false  (array is not a valid signal)",
  () => assert.strictEqual(normalizeConsentBool([true]), false)
);

runTest(
  "array [1]          → false",
  () => assert.strictEqual(normalizeConsentBool([1]), false)
);

runTest(
  "NaN               → false",
  () => assert.strictEqual(normalizeConsentBool(NaN), false)
);

runTest(
  "Infinity          → false",
  () => assert.strictEqual(normalizeConsentBool(Infinity), false)
);

runTest(
  "function () {}    → false",
  () => assert.strictEqual(normalizeConsentBool(() => {}), false)
);

// ── Suite 7: Return type is always a strict native boolean ────────────────────

console.log("\n[Suite 7] Output is always typeof === \"boolean\" — never truthy/falsy non-boolean");

runTest(
  'typeof normalizeConsentBool("true") === "boolean"',
  () => assert.strictEqual(typeof normalizeConsentBool("true"), "boolean")
);

runTest(
  "typeof normalizeConsentBool(1) === \"boolean\"",
  () => assert.strictEqual(typeof normalizeConsentBool(1), "boolean")
);

runTest(
  "typeof normalizeConsentBool(null) === \"boolean\"",
  () => assert.strictEqual(typeof normalizeConsentBool(null), "boolean")
);

runTest(
  "typeof normalizeConsentBool(undefined) === \"boolean\"",
  () => assert.strictEqual(typeof normalizeConsentBool(undefined), "boolean")
);

runTest(
  "typeof normalizeConsentBool({}) === \"boolean\"",
  () => assert.strictEqual(typeof normalizeConsentBool({}), "boolean")
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent bool normalizer contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
