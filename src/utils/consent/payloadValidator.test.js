"use strict";

/**
 * Canonical unit test for src/utils/consent/payloadValidator.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { validateConsentPayload } = require("./payloadValidator");

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

// ── Suite 1: Perfectly structured valid payload ───────────────────────────────

console.log("\n[Suite 1] Valid payload — happy path");

const VALID_PAYLOAD = {
  userId: "usr_abdulgaffar_2026",
  timestamp: 1748701200,
  preferences: {
    functional: true,
    analytics: false,
    marketing: true,
  },
};

runTest(
  "valid payload returns { valid: true }",
  () => {
    const result = validateConsentPayload(VALID_PAYLOAD);
    assert.strictEqual(result.valid, true, `Expected valid:true, got: ${JSON.stringify(result)}`);
  }
);

runTest(
  "sanitized property references the original payload object",
  () => {
    const result = validateConsentPayload(VALID_PAYLOAD);
    assert.strictEqual(
      result.sanitized,
      VALID_PAYLOAD,
      "sanitized must be the same object reference as the input payload"
    );
  }
);

runTest(
  "valid result carries no error property",
  () => {
    const result = validateConsentPayload(VALID_PAYLOAD);
    assert.strictEqual(
      result.error,
      undefined,
      "A passing result must not contain an error field"
    );
  }
);

runTest(
  "all-false preference switches are still valid booleans",
  () => {
    const result = validateConsentPayload({
      userId: "usr_minimal",
      timestamp: 0,
      preferences: { functional: false, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, true);
  }
);

// ── Suite 2: Completely missing top-level fields ──────────────────────────────

console.log("\n[Suite 2] Missing required top-level fields");

runTest(
  "empty object → valid:false with informative error",
  () => {
    const result = validateConsentPayload({});
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0,
      "Expected a non-empty error string");
  }
);

runTest(
  "missing userId → valid:false mentioning userId",
  () => {
    const result = validateConsentPayload({
      timestamp: 1748701200,
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"),
      `Error should reference userId, got: "${result.error}"`);
  }
);

runTest(
  "missing timestamp → valid:false mentioning timestamp",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"),
      `Error should reference timestamp, got: "${result.error}"`);
  }
);

runTest(
  "missing preferences → valid:false mentioning preferences",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("preferences"),
      `Error should reference preferences, got: "${result.error}"`);
  }
);

// ── Suite 3: Corrupted payload data types ─────────────────────────────────────

console.log("\n[Suite 3] Corrupted field data types");

runTest(
  "userId as number → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: 99,
      timestamp: 1748701200,
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"));
  }
);

runTest(
  "userId as empty string → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "   ",
      timestamp: 1748701200,
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("userid"));
  }
);

runTest(
  "timestamp as string → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: "1748701200",
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  }
);

runTest(
  "timestamp as float → valid:false (must be integer)",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200.5,
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  }
);

runTest(
  "timestamp as negative integer → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: -1,
      preferences: { functional: true, analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  }
);

runTest(
  "preferences as array → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: [true, false, true],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("preferences"));
  }
);

runTest(
  "preferences as string → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: "all-on",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.toLowerCase().includes("preferences"));
  }
);

// ── Suite 4: Missing / malformed nested preference switches ───────────────────

console.log("\n[Suite 4] Missing or malformed nested preference switches");

runTest(
  "missing preferences.functional → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: { analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("functional"),
      `Error should name missing key, got: "${result.error}"`);
  }
);

runTest(
  "missing preferences.analytics → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: { functional: true, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("analytics"));
  }
);

runTest(
  "missing preferences.marketing → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: { functional: true, analytics: true },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("marketing"));
  }
);

runTest(
  "preferences.functional as string → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: { functional: "yes", analytics: false, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("functional"));
  }
);

runTest(
  "preferences.analytics as number → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: { functional: true, analytics: 1, marketing: false },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("analytics"));
  }
);

runTest(
  "preferences.marketing as null → valid:false",
  () => {
    const result = validateConsentPayload({
      userId: "usr_test",
      timestamp: 1748701200,
      preferences: { functional: true, analytics: false, marketing: null },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("marketing"));
  }
);

// ── Suite 5: Structural integrity — invalid top-level input types ─────────────

console.log("\n[Suite 5] Structural integrity — invalid top-level input types");

runTest(
  "null payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(null);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

runTest(
  "undefined payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(undefined);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

runTest(
  "array payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload([]);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

runTest(
  "string payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload("consent-payload");
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

runTest(
  "numeric payload → valid:false, no throw",
  () => {
    const result = validateConsentPayload(42);
    assert.strictEqual(result.valid, false);
    assert.ok(typeof result.error === "string");
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent payload validation contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
