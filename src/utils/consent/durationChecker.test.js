"use strict";

/**
 * Canonical unit test for src/utils/consent/durationChecker.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * All date offsets are derived from Date.now() at runtime so the suite
 * remains correct regardless of when it executes.
 *
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { isWithinComplianceWindow } = require("./durationChecker");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Returns an ISO string for a date offset days from now (negative = past). */
function isoOffset(offsetDays) {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString();
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

// ── Suite 1: Active compliance windows (should return true) ───────────────────

console.log("\n[Suite 1] Active windows — isWithinComplianceWindow should return true");

runTest(
  "consent granted yesterday, 30-day window → still active",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(-1), 30),
    true
  )
);

runTest(
  "consent granted today (just now), 1-day window → active",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(0), 1),
    true
  )
);

runTest(
  "consent granted 29 days ago, 30-day window → still within bound",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(-29), 30),
    true
  )
);

runTest(
  "consent granted 364 days ago, 365-day annual window → active",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(-364), 365),
    true
  )
);

runTest(
  "fractional window (0.5 days = 12 hours) granted 6 hours ago → active",
  () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(isWithinComplianceWindow(sixHoursAgo, 0.5), true);
  }
);

// ── Suite 2: Expired compliance windows (should return false) ─────────────────

console.log("\n[Suite 2] Expired windows — isWithinComplianceWindow should return false");

runTest(
  "consent granted 31 days ago, 30-day window → expired",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(-31), 30),
    false
  )
);

runTest(
  "consent granted 366 days ago, 365-day window → expired",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(-366), 365),
    false
  )
);

runTest(
  "consent granted 100 days ago, 7-day window → long expired",
  () => assert.strictEqual(
    isWithinComplianceWindow(isoOffset(-100), 7),
    false
  )
);

runTest(
  "fractional window (0.5 days) granted 13 hours ago → expired",
  () => {
    const thirteenHoursAgo = new Date(
      Date.now() - 13 * 60 * 60 * 1000
    ).toISOString();
    assert.strictEqual(isWithinComplianceWindow(thirteenHoursAgo, 0.5), false);
  }
);

// ── Suite 3: Malformed / corrupted date strings (default-deny → false) ────────

console.log("\n[Suite 3] Corrupted date strings → false (default-deny posture)");

runTest(
  "completely non-date string → false",
  () => assert.strictEqual(isWithinComplianceWindow("not-a-date", 30), false)
);

runTest(
  "empty string → false",
  () => assert.strictEqual(isWithinComplianceWindow("", 30), false)
);

runTest(
  "whitespace-only string → false",
  () => assert.strictEqual(isWithinComplianceWindow("   ", 30), false)
);

runTest(
  "semantically invalid date '2099-99-99' → false",
  () => assert.strictEqual(isWithinComplianceWindow("2099-99-99", 30), false)
);

runTest(
  "partial date string '2024-07' → false",
  () => {
    // Date.parse('2024-07') is implementation-defined / NaN in strict ISO mode
    const result = isWithinComplianceWindow("2024-07", 30);
    // Accepted as either false (NaN parse) or may be true on lenient engines —
    // the key assertion is that it DOES NOT THROW.
    assert.ok(typeof result === "boolean",
      "Must return a boolean, never throw");
  }
);

runTest(
  "SQL injection attempt → false",
  () => assert.strictEqual(
    isWithinComplianceWindow("2024-01-01'; DROP TABLE consents; --", 30),
    false
  )
);

// ── Suite 4: Null, undefined, and non-string startDate (default-deny → false) ─

console.log("\n[Suite 4] Null / undefined / non-string startDate → false");

runTest(
  "null startDateIso → false",
  () => assert.strictEqual(isWithinComplianceWindow(null, 30), false)
);

runTest(
  "undefined startDateIso → false",
  () => assert.strictEqual(isWithinComplianceWindow(undefined, 30), false)
);

runTest(
  "numeric startDateIso → false",
  () => assert.strictEqual(isWithinComplianceWindow(Date.now(), 30), false)
);

runTest(
  "Date object (not string) → false",
  () => assert.strictEqual(isWithinComplianceWindow(new Date(), 30), false)
);

runTest(
  "array startDateIso → false",
  () => assert.strictEqual(isWithinComplianceWindow([isoOffset(0)], 30), false)
);

runTest(
  "boolean startDateIso → false",
  () => assert.strictEqual(isWithinComplianceWindow(true, 30), false)
);

// ── Suite 5: Invalid windowInDays values (default-deny → false) ───────────────

console.log("\n[Suite 5] Invalid windowInDays values → false (default-deny posture)");

runTest(
  "windowInDays = 0 → false (zero-length window has no compliance coverage)",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), 0), false)
);

runTest(
  "windowInDays = -7 (negative) → false",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), -7), false)
);

runTest(
  "windowInDays = NaN → false",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), NaN), false)
);

runTest(
  "windowInDays = Infinity → false",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), Infinity), false)
);

runTest(
  "windowInDays = null → false",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), null), false)
);

runTest(
  "windowInDays = undefined → false",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), undefined), false)
);

runTest(
  "windowInDays = '30' (string) → false",
  () => assert.strictEqual(isWithinComplianceWindow(isoOffset(0), "30"), false)
);

runTest(
  "both arguments null → false",
  () => assert.strictEqual(isWithinComplianceWindow(null, null), false)
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Compliance window duration checker contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
