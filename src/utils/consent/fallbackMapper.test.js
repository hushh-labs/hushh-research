"use strict";

/**
 * Canonical unit test for src/utils/consent/fallbackMapper.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { applyPrivacyFallbacks } = require("./fallbackMapper");

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

// ── Suite 1: Profile with explicit preferences — values remain untouched ──────

console.log("\n[Suite 1] Explicit preferences present — values must be preserved unchanged");

runTest(
  "all three switches explicitly true are returned as true",
  () => {
    const result = applyPrivacyFallbacks({
      functional: true,
      analytics:  true,
      marketing:  true,
    });
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics,  true);
    assert.strictEqual(result.marketing,  true);
  }
);

runTest(
  "all three switches explicitly false are returned as false",
  () => {
    const result = applyPrivacyFallbacks({
      functional: false,
      analytics:  false,
      marketing:  false,
    });
    assert.strictEqual(result.functional, false);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "mixed true/false preferences are preserved exactly as supplied",
  () => {
    const result = applyPrivacyFallbacks({
      functional: true,
      analytics:  false,
      marketing:  true,
    });
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  true);
  }
);

runTest(
  "extra profile fields (userId, email) are preserved alongside privacy switches",
  () => {
    const result = applyPrivacyFallbacks({
      userId:     "usr_abdulgaffar_2026",
      email:      "abdulgaffar@hushh.ai",
      functional: true,
      analytics:  false,
      marketing:  false,
    });
    assert.strictEqual(result.userId,     "usr_abdulgaffar_2026");
    assert.strictEqual(result.email,      "abdulgaffar@hushh.ai");
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "returned object is a new reference — the original input is not mutated",
  () => {
    const original = { functional: true, analytics: false, marketing: true };
    const result   = applyPrivacyFallbacks(original);

    // Must be a distinct allocation
    assert.notStrictEqual(result, original,
      "applyPrivacyFallbacks must return a new object, not the same reference");

    // Original values must be untouched
    assert.strictEqual(original.functional, true);
    assert.strictEqual(original.analytics,  false);
    assert.strictEqual(original.marketing,  true);
  }
);

runTest(
  "mutating the returned object does not affect the original profile",
  () => {
    const original = { functional: true, analytics: true, marketing: true };
    const result   = applyPrivacyFallbacks(original);
    result.functional = false; // deliberate mutation of the copy

    assert.strictEqual(original.functional, true,
      "Mutating the returned copy must not bleed back into the original");
  }
);

// ── Suite 2: Empty profile → full maximum-privacy fallback ────────────────────

console.log("\n[Suite 2] Empty / minimal profile — full false fallbacks applied");

runTest(
  "empty object {} receives functional:false, analytics:false, marketing:false",
  () => {
    const result = applyPrivacyFallbacks({});
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "profile with only non-privacy fields gets all three switches set to false",
  () => {
    const result = applyPrivacyFallbacks({
      userId: "usr_test",
      email:  "test@hushh.ai",
    });
    assert.strictEqual(result.userId,     "usr_test");
    assert.strictEqual(result.email,      "test@hushh.ai");
    assert.strictEqual(result.functional, false);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "result always contains all three privacy keys even when none were provided",
  () => {
    const result = applyPrivacyFallbacks({});
    assert.ok("functional" in result, "functional key must be present");
    assert.ok("analytics"  in result, "analytics key must be present");
    assert.ok("marketing"  in result, "marketing key must be present");
  }
);

// ── Suite 3: Partial profile → only missing keys filled in ───────────────────

console.log("\n[Suite 3] Partial profiles — only absent switches receive false fallback");

runTest(
  "only functional:true supplied → analytics and marketing default to false",
  () => {
    const result = applyPrivacyFallbacks({ functional: true });
    assert.strictEqual(result.functional, true,
      "Existing boolean must be preserved");
    assert.strictEqual(result.analytics,  false,
      "Missing analytics must default to false");
    assert.strictEqual(result.marketing,  false,
      "Missing marketing must default to false");
  }
);

runTest(
  "analytics and marketing supplied → functional defaults to false",
  () => {
    const result = applyPrivacyFallbacks({ analytics: true, marketing: false });
    assert.strictEqual(result.functional, false);
    assert.strictEqual(result.analytics,  true);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "two of three switches supplied — only the absent one receives false",
  () => {
    const result = applyPrivacyFallbacks({ functional: true, analytics: true });
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics,  true);
    assert.strictEqual(result.marketing,  false,
      "Only the absent marketing key must be defaulted to false");
  }
);

runTest(
  "partial profile with extra fields — extra fields preserved, gaps filled",
  () => {
    const result = applyPrivacyFallbacks({
      sessionId:  "sess_xyz",
      functional: false,
    });
    assert.strictEqual(result.sessionId,  "sess_xyz");
    assert.strictEqual(result.functional, false);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

// ── Suite 4: Type-safety boundaries — null, invalid, and non-boolean values ───

console.log("\n[Suite 4] Type-safety — null / invalid inputs and non-boolean switch values");

runTest(
  "null input → { functional:false, analytics:false, marketing:false }, no throw",
  () => {
    const result = applyPrivacyFallbacks(null);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "undefined input → full false fallback, no throw",
  () => {
    const result = applyPrivacyFallbacks(undefined);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "string input → full false fallback, no throw",
  () => {
    const result = applyPrivacyFallbacks("all-on");
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "number input → full false fallback, no throw",
  () => {
    const result = applyPrivacyFallbacks(42);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "array input → full false fallback, no throw",
  () => {
    const result = applyPrivacyFallbacks([true, false, true]);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  'string "true" for a switch is not an explicit boolean — defaults to false',
  () => {
    const result = applyPrivacyFallbacks({
      functional: "true",
      analytics:  "false",
      marketing:  "true",
    });
    assert.strictEqual(result.functional, false,
      '"true" is not a boolean — must be treated as absent');
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "numeric 1 / 0 for switches are not explicit booleans — both default to false",
  () => {
    const result = applyPrivacyFallbacks({
      functional: 1,
      analytics:  0,
      marketing:  1,
    });
    assert.strictEqual(result.functional, false);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "null individual switch values default to false",
  () => {
    const result = applyPrivacyFallbacks({
      functional: null,
      analytics:  null,
      marketing:  null,
    });
    assert.strictEqual(result.functional, false);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Privacy fallback mapper contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
