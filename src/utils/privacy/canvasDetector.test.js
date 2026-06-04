"use strict";

/**
 * Canonical unit test for src/utils/privacy/canvasDetector.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { isCanvasFingerprintAttempt } = require("./canvasDetector");

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

// ── Suite 1: Sensitive methods above threshold (callCount > 5) → true ─────────

console.log("\n[Suite 1] Sensitive methods called > 5 times → fingerprint flagged (true)");

runTest(
  '"toDataURL"   callCount=6  → true  (first count over threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",   6),   true)
);

runTest(
  '"toDataURL"   callCount=10 → true',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",   10),  true)
);

runTest(
  '"toDataURL"   callCount=100 → true (aggressive probe loop)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",   100), true)
);

runTest(
  '"getImageData" callCount=6  → true',
  () => assert.strictEqual(isCanvasFingerprintAttempt("getImageData", 6),  true)
);

runTest(
  '"getImageData" callCount=50 → true',
  () => assert.strictEqual(isCanvasFingerprintAttempt("getImageData", 50), true)
);

runTest(
  '"toBlob"       callCount=6  → true  (async extraction variant)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toBlob",      6),   true)
);

runTest(
  '"toBlob"       callCount=20 → true',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toBlob",      20),  true)
);

// ── Suite 2: Sensitive methods at or below threshold → false ──────────────────

console.log("\n[Suite 2] Sensitive methods at/below threshold (callCount ≤ 5) → false");

runTest(
  '"toDataURL"    callCount=5  → false (at threshold, NOT over)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",    5),  false)
);

runTest(
  '"toDataURL"    callCount=4  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",    4),  false)
);

runTest(
  '"toDataURL"    callCount=1  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",    1),  false)
);

runTest(
  '"toDataURL"    callCount=0  → false (never called)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",    0),  false)
);

runTest(
  '"getImageData" callCount=5  → false (at threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("getImageData", 5),  false)
);

runTest(
  '"getImageData" callCount=3  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("getImageData", 3),  false)
);

runTest(
  '"toBlob"       callCount=5  → false (at threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toBlob",       5),  false)
);

// ── Suite 3: Generic drawing methods — never flagged regardless of count ──────

console.log("\n[Suite 3] Generic drawing methods — never flagged regardless of call count");

runTest(
  '"lineTo"        callCount=100 → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("lineTo",        100), false)
);

runTest(
  '"stroke"        callCount=100 → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("stroke",        100), false)
);

runTest(
  '"fillRect"      callCount=200 → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("fillRect",      200), false)
);

runTest(
  '"beginPath"     callCount=500 → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("beginPath",     500), false)
);

runTest(
  '"arc"           callCount=50  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("arc",           50),  false)
);

runTest(
  '"drawImage"     callCount=10  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("drawImage",     10),  false)
);

runTest(
  '"clearRect"     callCount=99  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("clearRect",     99),  false)
);

runTest(
  '"moveTo"        callCount=1000 → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("moveTo",        1000), false)
);

runTest(
  '"fillText"      callCount=10  → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("fillText",      10),  false)
);

// ── Suite 4: Exact threshold boundary — 5 is safe, 6 is flagged ──────────────

console.log("\n[Suite 4] Exact threshold boundary — callCount=5 safe, callCount=6 flagged");

runTest(
  '"toDataURL"   callCount=5 → false (boundary: at threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",   5), false)
);

runTest(
  '"toDataURL"   callCount=6 → true  (boundary: one over threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",   6), true)
);

runTest(
  '"getImageData" callCount=5 → false (boundary: at threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("getImageData", 5), false)
);

runTest(
  '"getImageData" callCount=6 → true  (boundary: one over threshold)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("getImageData", 6), true)
);

// ── Suite 5: Case sensitivity — canvas API method names are case-sensitive ─────

console.log("\n[Suite 5] Case sensitivity — only exact-case method names match");

runTest(
  '"TODATAURL"   callCount=100 → false (all-caps, not registered)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("TODATAURL",    100), false)
);

runTest(
  '"ToDataURL"   callCount=100 → false (title-case, not registered)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("ToDataURL",    100), false)
);

runTest(
  '"todataurl"   callCount=100 → false (all-lower, not registered)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("todataurl",    100), false)
);

runTest(
  '"GETIMAGEDATA" callCount=10 → false (all-caps)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("GETIMAGEDATA", 10),  false)
);

runTest(
  '"toDataURL"   callCount=6  → true  (exact canonical case — confirmed)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL",    6),   true)
);

// ── Suite 6: Invalid ctxMethodName → false ────────────────────────────────────

console.log("\n[Suite 6] Invalid ctxMethodName → false (no throw)");

runTest(
  'null methodName → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(null,      6),   false)
);

runTest(
  'undefined methodName → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(undefined, 6),   false)
);

runTest(
  'empty string "" → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("",        6),   false)
);

runTest(
  'whitespace-only "   " → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("   ",     6),   false)
);

runTest(
  'number 42 as methodName → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(42,        6),   false)
);

runTest(
  'boolean true as methodName → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(true,      6),   false)
);

runTest(
  'array ["toDataURL"] as methodName → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(["toDataURL"], 6), false)
);

runTest(
  'object {name:"toDataURL"} as methodName → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt({ name: "toDataURL" }, 6), false)
);

// ── Suite 7: Invalid callCount → false ───────────────────────────────────────

console.log("\n[Suite 7] Invalid callCount → false (no throw)");

runTest(
  '"toDataURL" callCount=null → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", null),      false)
);

runTest(
  '"toDataURL" callCount=undefined → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", undefined), false)
);

runTest(
  '"toDataURL" callCount=NaN → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", NaN),       false)
);

runTest(
  '"toDataURL" callCount=Infinity → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", Infinity),  false)
);

runTest(
  '"toDataURL" callCount=-Infinity → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", -Infinity), false)
);

runTest(
  '"toDataURL" callCount=-1 → false (negative count invalid)',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", -1),        false)
);

runTest(
  '"toDataURL" callCount=-100 → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", -100),      false)
);

runTest(
  '"toDataURL" callCount="6" (string) → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt("toDataURL", "6"),       false)
);

runTest(
  'both args null → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(null, null),             false)
);

runTest(
  'no arguments → false',
  () => assert.strictEqual(isCanvasFingerprintAttempt(),                       false)
);

// ── Suite 8: Return type is always a strict boolean ───────────────────────────

console.log("\n[Suite 8] Return type is always strict boolean (not truthy/falsy)");

runTest(
  "fingerprint detected → result is strictly === true",
  () => {
    const result = isCanvasFingerprintAttempt("toDataURL", 10);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, true);
  }
);

runTest(
  "safe sensitive call → result is strictly === false",
  () => {
    const result = isCanvasFingerprintAttempt("toDataURL", 3);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

runTest(
  "drawing method → result is strictly === false",
  () => {
    const result = isCanvasFingerprintAttempt("lineTo", 100);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

runTest(
  "invalid input → result is strictly === false",
  () => {
    const result = isCanvasFingerprintAttempt(null, null);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Canvas fingerprint detector contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
