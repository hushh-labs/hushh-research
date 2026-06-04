"use strict";

/**
 * Canonical unit test for src/utils/privacy/tokenGuard.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * All timing assertions use large offsets (hours) so they remain stable
 * across the full test run regardless of execution speed.
 *
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { isTokenExpired } = require("./tokenGuard");

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

// Stable timing anchors — computed once so every test in the suite shares
// the same reference point.
const NOW          = Date.now();
const ONE_SECOND   = 1_000;        // ms
const ONE_MINUTE   = 60_000;       // ms
const ONE_HOUR_MS  = 3_600_000;    // ms
const ONE_HOUR_S   = 3_600;        // seconds — standard TTL used throughout
const TWO_HOURS_MS = 7_200_000;    // ms
const ONE_DAY_MS   = 86_400_000;   // ms

// ── Suite 1: Active tokens — still within TTL window → false ─────────────────

console.log("\n[Suite 1] Active tokens — within TTL window → false");

runTest(
  "token created 1 second ago, TTL 1 hour → false",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, ONE_HOUR_S),
    false
  )
);

runTest(
  "token created 30 minutes ago, TTL 1 hour → false",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - 30 * ONE_MINUTE }, ONE_HOUR_S),
    false
  )
);

runTest(
  "token created 59 minutes 59 seconds ago, TTL 1 hour → false (inside window by 1 s)",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - (ONE_HOUR_MS - ONE_SECOND) }, ONE_HOUR_S),
    false
  )
);

runTest(
  "token created 1 hour ago, TTL 24 hours → false (large TTL)",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_HOUR_MS }, 86_400),
    false
  )
);

runTest(
  "token created 1 second ago, TTL 2 hours → false",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, ONE_HOUR_S * 2),
    false
  )
);

runTest(
  "token with extra payload fields present — only createdAt is consumed → false",
  () => assert.strictEqual(
    isTokenExpired(
      { createdAt: NOW - ONE_SECOND, userId: "u-123", scope: "read" },
      ONE_HOUR_S
    ),
    false
  )
);

// ── Suite 2: Expired tokens → true ───────────────────────────────────────────

console.log("\n[Suite 2] Expired tokens — past TTL window → true");

runTest(
  "token created 2 hours ago, TTL 1 hour → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - TWO_HOURS_MS }, ONE_HOUR_S),
    true
  )
);

runTest(
  "token created 1 day ago, TTL 1 hour → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_DAY_MS }, ONE_HOUR_S),
    true
  )
);

runTest(
  "token created 7 days ago, TTL 1 hour → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - 7 * ONE_DAY_MS }, ONE_HOUR_S),
    true
  )
);

runTest(
  "token created 2 hours ago, TTL 30 minutes → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - TWO_HOURS_MS }, 1_800),
    true
  )
);

runTest(
  "very old token (Unix epoch ms ~1) with TTL 1 hour → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: 1 }, ONE_HOUR_S),
    true
  )
);

// ── Suite 3: TTL boundary conditions ─────────────────────────────────────────

console.log("\n[Suite 3] TTL boundary conditions");

runTest(
  "TTL = 0 seconds — token expires at the instant of creation → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, 0),
    true
  )
);

runTest(
  "TTL = 1 second, token created 2 seconds ago → true (just past boundary)",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - 2 * ONE_SECOND }, 1),
    true
  )
);

runTest(
  "TTL = 1 second, token created 500 ms ago → false (inside boundary)",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - 500 }, 1),
    false
  )
);

runTest(
  "TTL = 7200 seconds (2 hours), token created 1 hour ago → false",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_HOUR_MS }, 7_200),
    false
  )
);

runTest(
  "TTL = 7200 seconds (2 hours), token created 3 hours ago → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - 3 * ONE_HOUR_MS }, 7_200),
    true
  )
);

runTest(
  "future createdAt (clock skew scenario) with TTL 1 hour → false (window not yet reached)",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW + ONE_HOUR_MS }, ONE_HOUR_S),
    false
  )
);

// ── Suite 4: Malformed tokenPayload → true (default-deny) ────────────────────

console.log("\n[Suite 4] Malformed tokenPayload → true (default-deny)");

runTest(
  "null tokenPayload → true",
  () => assert.strictEqual(isTokenExpired(null, ONE_HOUR_S), true)
);

runTest(
  "undefined tokenPayload → true",
  () => assert.strictEqual(isTokenExpired(undefined, ONE_HOUR_S), true)
);

runTest(
  "string tokenPayload → true",
  () => assert.strictEqual(isTokenExpired("token-string", ONE_HOUR_S), true)
);

runTest(
  "number tokenPayload → true",
  () => assert.strictEqual(isTokenExpired(12345, ONE_HOUR_S), true)
);

runTest(
  "array tokenPayload → true",
  () => assert.strictEqual(isTokenExpired([{ createdAt: NOW }], ONE_HOUR_S), true)
);

runTest(
  "boolean tokenPayload → true",
  () => assert.strictEqual(isTokenExpired(true, ONE_HOUR_S), true)
);

runTest(
  "empty object {} (no createdAt field) → true",
  () => assert.strictEqual(isTokenExpired({}, ONE_HOUR_S), true)
);

// ── Suite 5: Malformed createdAt → true (default-deny) ───────────────────────

console.log("\n[Suite 5] Malformed createdAt → true (default-deny)");

runTest(
  "createdAt: null → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: null }, ONE_HOUR_S), true)
);

runTest(
  "createdAt: undefined → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: undefined }, ONE_HOUR_S), true)
);

runTest(
  "createdAt: NaN → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: NaN }, ONE_HOUR_S), true)
);

runTest(
  "createdAt: Infinity → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: Infinity }, ONE_HOUR_S), true)
);

runTest(
  "createdAt: -Infinity → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: -Infinity }, ONE_HOUR_S), true)
);

runTest(
  'createdAt: string "1700000000000" (stringified timestamp) → true',
  () => assert.strictEqual(
    isTokenExpired({ createdAt: "1700000000000" }, ONE_HOUR_S),
    true
  )
);

runTest(
  "createdAt: 0 (zero epoch) → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: 0 }, ONE_HOUR_S), true)
);

runTest(
  "createdAt: -1 (negative timestamp) → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: -1 }, ONE_HOUR_S), true)
);

runTest(
  "createdAt: boolean true → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: true }, ONE_HOUR_S), true)
);

// ── Suite 6: Malformed ttlInSeconds → true (default-deny) ────────────────────

console.log("\n[Suite 6] Malformed ttlInSeconds → true (default-deny)");

runTest(
  "ttlInSeconds: null → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: NOW - ONE_SECOND }, null), true)
);

runTest(
  "ttlInSeconds: undefined → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, undefined),
    true
  )
);

runTest(
  "ttlInSeconds: NaN → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: NOW - ONE_SECOND }, NaN), true)
);

runTest(
  "ttlInSeconds: Infinity → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, Infinity),
    true
  )
);

runTest(
  "ttlInSeconds: -1 (negative duration) → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: NOW - ONE_SECOND }, -1), true)
);

runTest(
  "ttlInSeconds: -3600 (large negative) → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, -3600),
    true
  )
);

runTest(
  'ttlInSeconds: string "3600" (stringified number) → true',
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, "3600"),
    true
  )
);

runTest(
  "ttlInSeconds: boolean false → true",
  () => assert.strictEqual(
    isTokenExpired({ createdAt: NOW - ONE_SECOND }, false),
    true
  )
);

runTest(
  "no second argument (ttlInSeconds missing entirely) → true",
  () => assert.strictEqual(isTokenExpired({ createdAt: NOW - ONE_SECOND }), true)
);

// ── Suite 7: Return type is always a strict boolean ──────────────────────────

console.log("\n[Suite 7] Return type is always strict boolean (not truthy/falsy)");

runTest(
  "active token result is strictly === false",
  () => {
    const result = isTokenExpired({ createdAt: NOW - ONE_SECOND }, ONE_HOUR_S);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

runTest(
  "expired token result is strictly === true",
  () => {
    const result = isTokenExpired({ createdAt: NOW - TWO_HOURS_MS }, ONE_HOUR_S);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, true);
  }
);

runTest(
  "invalid input result is strictly === true",
  () => {
    const result = isTokenExpired(null, ONE_HOUR_S);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, true);
  }
);

// ── Suite 8: Default-deny symmetry — all failure paths return true ────────────

console.log("\n[Suite 8] Default-deny symmetry — every bad-input variant returns true");

const badInputCases = [
  ["null payload, null TTL",      null,              null],
  ["undefined payload, undef TTL",undefined,         undefined],
  ["both arguments missing",      undefined,         undefined],
  ["array payload, valid TTL",    [NOW],             ONE_HOUR_S],
  ["valid payload, NaN TTL",      { createdAt: NOW }, NaN],
  ["NaN createdAt, valid TTL",    { createdAt: NaN }, ONE_HOUR_S],
  ["zero createdAt, valid TTL",   { createdAt: 0 },   ONE_HOUR_S],
];

for (const [label, payload, ttl] of badInputCases) {
  runTest(
    `${label} → true`,
    () => assert.strictEqual(isTokenExpired(payload, ttl), true,
      `Expected true for: payload=${JSON.stringify(payload)}, ttl=${ttl}`)
  );
}

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Token guard expiry contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
