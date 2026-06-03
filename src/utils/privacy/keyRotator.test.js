"use strict";

/**
 * Canonical unit test for src/utils/privacy/keyRotator.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * All timestamps are derived from Date.now() at runtime so the suite
 * remains correct regardless of when it executes.
 *
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { needsKeyRotation } = require("./keyRotator");

const MS_PER_HOUR = 60 * 60 * 1000;

/** Returns an ISO string offset hours from now (negative = past). */
function hoursAgo(h) {
  return new Date(Date.now() - h * MS_PER_HOUR).toISOString();
}

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

// ── Suite 1: Keys within valid operational limits → false ─────────────────────

console.log("\n[Suite 1] Key still valid — needsKeyRotation should return false");

runTest(
  "5-hour old key with 12-hour limit → false (well within window)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(5), 12), false)
);

runTest(
  "1-hour old key with 24-hour limit → false",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), 24), false)
);

runTest(
  "key rotated moments ago with 1-hour limit → false",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(0), 1), false)
);

runTest(
  "11.9-hour old key with 12-hour limit → false (just inside window)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(11.9), 12), false)
);

runTest(
  "future-dated key (clock-skew tolerance) → false",
  () => {
    const future = new Date(Date.now() + 2 * MS_PER_HOUR).toISOString();
    assert.strictEqual(needsKeyRotation(future, 24), false);
  }
);

// ── Suite 2: Keys that have exceeded their lifespan → true ───────────────────

console.log("\n[Suite 2] Key expired — needsKeyRotation should return true");

runTest(
  "24-hour old key with 12-hour limit → true (expired)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(24), 12), true)
);

runTest(
  "13-hour old key with 12-hour limit → true (just past window)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(13), 12), true)
);

runTest(
  "72-hour old key with 24-hour limit → true (3× over limit)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(72), 24), true)
);

runTest(
  "1-hour old key with 0.5-hour (30 min) limit → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), 0.5), true)
);

runTest(
  "key exactly at limit (12 h old, 12 h limit) → true (boundary = rotate)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(12), 12), true)
);

// ── Suite 3: Malformed / invalid lastRotatedIso → true (force rotation) ──────

console.log("\n[Suite 3] Malformed date inputs → true (strict security posture)");

runTest(
  "null lastRotatedIso → true",
  () => assert.strictEqual(needsKeyRotation(null, 24), true)
);

runTest(
  "undefined lastRotatedIso → true",
  () => assert.strictEqual(needsKeyRotation(undefined, 24), true)
);

runTest(
  "empty string lastRotatedIso → true",
  () => assert.strictEqual(needsKeyRotation("", 24), true)
);

runTest(
  "whitespace-only string → true",
  () => assert.strictEqual(needsKeyRotation("   ", 24), true)
);

runTest(
  "non-date string 'not-a-date' → true",
  () => assert.strictEqual(needsKeyRotation("not-a-date", 24), true)
);

runTest(
  "semantically invalid date '2099-99-99' → true",
  () => assert.strictEqual(needsKeyRotation("2099-99-99", 24), true)
);

runTest(
  "numeric timestamp (not a string) → true",
  () => assert.strictEqual(needsKeyRotation(Date.now(), 24), true)
);

runTest(
  "Date object (not a string) → true",
  () => assert.strictEqual(needsKeyRotation(new Date(), 24), true)
);

runTest(
  "array input → true",
  () => assert.strictEqual(needsKeyRotation([hoursAgo(1)], 24), true)
);

// ── Suite 4: Invalid maxAgeInHours → true (force rotation) ───────────────────

console.log("\n[Suite 4] Invalid maxAgeInHours → true (strict security posture)");

runTest(
  "maxAgeInHours = null → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), null), true)
);

runTest(
  "maxAgeInHours = undefined → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), undefined), true)
);

runTest(
  "maxAgeInHours = NaN → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), NaN), true)
);

runTest(
  "maxAgeInHours = Infinity → true (non-finite is unsafe)",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), Infinity), true)
);

runTest(
  "maxAgeInHours = -1 (negative) → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), -1), true)
);

runTest(
  "maxAgeInHours = 0 (zero-length window) → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), 0), true)
);

runTest(
  "maxAgeInHours = '24' (string) → true",
  () => assert.strictEqual(needsKeyRotation(hoursAgo(1), "24"), true)
);

runTest(
  "both arguments null → true",
  () => assert.strictEqual(needsKeyRotation(null, null), true)
);

// ── Suite 5: Return type is always a strict native boolean ────────────────────

console.log("\n[Suite 5] Output is always typeof === \"boolean\"");

runTest(
  'typeof needsKeyRotation(hoursAgo(1), 12) === "boolean"',
  () => assert.strictEqual(typeof needsKeyRotation(hoursAgo(1), 12), "boolean")
);

runTest(
  'typeof needsKeyRotation(null, 24) === "boolean"',
  () => assert.strictEqual(typeof needsKeyRotation(null, 24), "boolean")
);

runTest(
  'typeof needsKeyRotation(hoursAgo(100), 24) === "boolean"',
  () => assert.strictEqual(typeof needsKeyRotation(hoursAgo(100), 24), "boolean")
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Key rotation checker contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
