"use strict";

/**
 * Canonical unit test for src/utils/consent/expirationGate.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * All time offsets are computed from Date.now() at runtime so the suite
 * remains deterministically correct regardless of when it is executed.
 *
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { isConsentExpired } = require("./expirationGate");

const MS_PER_DAY = 86_400_000;

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

// ── Suite 1: Fresh / valid consent timestamps (should return false) ───────────

console.log("\n[Suite 1] Fresh consent timestamps — should return false (not expired)");

runTest(
  "fresh ms timestamp (Date.now()) is not expired under default TTL",
  () => {
    assert.strictEqual(isConsentExpired(Date.now(), 365), false);
  }
);

runTest(
  "fresh seconds timestamp (Math.floor(Date.now()/1000)) is not expired",
  () => {
    const secondsNow = Math.floor(Date.now() / 1000);
    assert.strictEqual(isConsentExpired(secondsNow, 365), false);
  }
);

runTest(
  "timestamp 1 day ago is not expired under default 365-day TTL",
  () => {
    const oneDayAgo = Date.now() - 1 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(oneDayAgo, 365), false);
  }
);

runTest(
  "timestamp 364 days ago is still within the 365-day TTL boundary",
  () => {
    const nearBoundary = Date.now() - 364 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(nearBoundary, 365), false,
      "364 days < 365-day TTL — consent must remain valid");
  }
);

runTest(
  "future timestamp (1 hour ahead) is not expired — clock-drift tolerance",
  () => {
    const oneHourAhead = Date.now() + 3_600_000;
    assert.strictEqual(isConsentExpired(oneHourAhead, 365), false,
      "A future timestamp must never be treated as expired");
  }
);

// ── Suite 2: Expired consent timestamps (should return true) ─────────────────

console.log("\n[Suite 2] Expired consent timestamps — should return true");

runTest(
  "timestamp 400 days ago is expired under default 365-day TTL",
  () => {
    const expired = Date.now() - 400 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(expired, 365), true,
      "400 days > 365-day TTL — consent must be expired");
  }
);

runTest(
  "timestamp 366 days ago is just over the 365-day TTL boundary",
  () => {
    const justOver = Date.now() - 366 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(justOver, 365), true);
  }
);

runTest(
  "ancient timestamp (Jan 1 2000 in ms) is expired under any reasonable TTL",
  () => {
    const year2000 = new Date("2000-01-01T00:00:00.000Z").getTime();
    assert.strictEqual(isConsentExpired(year2000, 365), true);
  }
);

runTest(
  "400-day-old consent provided as a seconds-based Unix timestamp is expired",
  () => {
    const secondsTs = Math.floor((Date.now() - 400 * MS_PER_DAY) / 1000);
    assert.strictEqual(isConsentExpired(secondsTs, 365), true,
      "Seconds-based expired timestamp must be detected correctly after ms conversion");
  }
);

runTest(
  "timestamp = 0 (Unix epoch, Jan 1 1970) is expired under any positive TTL",
  () => {
    assert.strictEqual(isConsentExpired(0, 365), true,
      "A zero timestamp represents the epoch — always expired");
  }
);

// ── Suite 3: Custom TTL boundary thresholds ───────────────────────────────────

console.log("\n[Suite 3] Custom TTL boundary thresholds");

runTest(
  "31-day-old timestamp is expired under a 30-day TTL",
  () => {
    const thirtyOneDaysAgo = Date.now() - 31 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(thirtyOneDaysAgo, 30), true);
  }
);

runTest(
  "29-day-old timestamp is valid under a 30-day TTL",
  () => {
    const twentyNineDaysAgo = Date.now() - 29 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(twentyNineDaysAgo, 30), false);
  }
);

runTest(
  "8-day-old timestamp is expired under a 7-day TTL",
  () => {
    const eightDaysAgo = Date.now() - 8 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(eightDaysAgo, 7), true);
  }
);

runTest(
  "6-day-old timestamp is valid under a 7-day TTL",
  () => {
    const sixDaysAgo = Date.now() - 6 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(sixDaysAgo, 7), false);
  }
);

runTest(
  "2-day-old timestamp is expired under a 1-day TTL",
  () => {
    const twoDaysAgo = Date.now() - 2 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(twoDaysAgo, 1), true);
  }
);

runTest(
  "TTL=730 days (2 years): 400-day-old timestamp is still valid",
  () => {
    const fourHundredDaysAgo = Date.now() - 400 * MS_PER_DAY;
    assert.strictEqual(isConsentExpired(fourHundredDaysAgo, 730), false,
      "400 days < 730-day TTL — consent must remain valid");
  }
);

// ── Suite 4: Fallback for empty / broken / invalid inputs (all → true) ────────

console.log("\n[Suite 4] Malformed inputs — all must return true (max-security fallback)");

runTest(
  "null timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired(null, 365), true)
);

runTest(
  "undefined timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired(undefined, 365), true)
);

runTest(
  "empty string timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired("", 365), true)
);

runTest(
  "non-numeric string timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired("not-a-date", 365), true)
);

runTest(
  "NaN timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired(NaN, 365), true)
);

runTest(
  "Infinity timestamp → true (non-finite, safe fallback)",
  () => assert.strictEqual(isConsentExpired(Infinity, 365), true)
);

runTest(
  "negative timestamp → true (pre-epoch, safe fallback)",
  () => assert.strictEqual(isConsentExpired(-1, 365), true)
);

runTest(
  "boolean timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired(true, 365), true)
);

runTest(
  "object timestamp → true (safe fallback)",
  () => assert.strictEqual(isConsentExpired({ ts: Date.now() }, 365), true)
);

runTest(
  "TTL = 0 → true (zero TTL is invalid — safe fallback)",
  () => assert.strictEqual(isConsentExpired(Date.now(), 0), true)
);

runTest(
  "TTL = -1 (negative) → true (invalid boundary — safe fallback)",
  () => assert.strictEqual(isConsentExpired(Date.now(), -1), true)
);

runTest(
  "TTL = NaN → true (invalid TTL — safe fallback)",
  () => assert.strictEqual(isConsentExpired(Date.now(), NaN), true)
);

runTest(
  "TTL = Infinity → true (non-finite TTL — safe fallback)",
  () => assert.strictEqual(isConsentExpired(Date.now(), Infinity), true)
);

runTest(
  'TTL = "365" (string) → true (wrong type — safe fallback)',
  () => assert.strictEqual(isConsentExpired(Date.now(), "365"), true)
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent expiration gate contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
