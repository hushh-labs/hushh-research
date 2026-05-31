"use strict";

/**
 * Canonical unit test for src/utils/consent/cookieEvaluator.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { evaluateCookieFlags } = require("./cookieEvaluator");

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

// ── Suite 1: Standard clean flag override ─────────────────────────────────────

console.log("\n[Suite 1] Standard clean boolean flag override");

runTest(
  "all valid boolean userFlags pass through unchanged",
  () => {
    const result = evaluateCookieFlags(
      { functional: true, analytics: true, marketing: false },
      { functional: false, analytics: false, marketing: false }
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, true);
    assert.strictEqual(result.marketing, false);
  }
);

runTest(
  "user true overrides default false across all three keys",
  () => {
    const result = evaluateCookieFlags(
      { functional: true, analytics: true, marketing: true },
      { functional: false, analytics: false, marketing: false }
    );
    assert.deepStrictEqual(result, {
      functional: true,
      analytics: true,
      marketing: true,
    });
  }
);

runTest(
  "user false overrides default true — user choice is always respected",
  () => {
    const result = evaluateCookieFlags(
      { functional: false, analytics: false, marketing: false },
      { functional: true, analytics: true, marketing: true }
    );
    assert.deepStrictEqual(result, {
      functional: false,
      analytics: false,
      marketing: false,
    });
  }
);

runTest(
  "output contains exactly the three known keys — unknown keys are dropped",
  () => {
    const result = evaluateCookieFlags(
      { functional: true, analytics: false, marketing: false, tracking: true, session: true },
      {}
    );
    assert.deepStrictEqual(Object.keys(result).sort(), [
      "analytics",
      "functional",
      "marketing",
    ]);
    assert.strictEqual("tracking" in result, false);
    assert.strictEqual("session" in result, false);
  }
);

runTest(
  "unknown keys in globalDefaults are also silently dropped",
  () => {
    const result = evaluateCookieFlags(
      {},
      { functional: false, analytics: false, marketing: false, secret: true }
    );
    assert.strictEqual("secret" in result, false);
    assert.deepStrictEqual(Object.keys(result).sort(), [
      "analytics",
      "functional",
      "marketing",
    ]);
  }
);

// ── Suite 2: Fallback evaluation when user values are missing ─────────────────

console.log("\n[Suite 2] Fallback evaluation — missing or partial userFlags");

runTest(
  "missing analytics in userFlags falls back to globalDefault",
  () => {
    const result = evaluateCookieFlags(
      { functional: true, marketing: false },
      { functional: false, analytics: true, marketing: false }
    );
    assert.strictEqual(result.analytics, true,  "analytics should come from default");
    assert.strictEqual(result.functional, true,  "functional should come from user");
    assert.strictEqual(result.marketing, false,  "marketing should come from user");
  }
);

runTest(
  "empty userFlags object → all three values sourced from globalDefaults",
  () => {
    const result = evaluateCookieFlags(
      {},
      { functional: true, analytics: false, marketing: true }
    );
    assert.deepStrictEqual(result, {
      functional: true,
      analytics: false,
      marketing: true,
    });
  }
);

runTest(
  "null userFlags with full globalDefaults → defaults are applied, no throw",
  () => {
    const result = evaluateCookieFlags(
      null,
      { functional: true, analytics: false, marketing: true }
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, true);
  }
);

runTest(
  "null userFlags + null globalDefaults → all flags resolve to false (safe default)",
  () => {
    const result = evaluateCookieFlags(null, null);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics: false,
      marketing: false,
    });
  }
);

runTest(
  "partial userFlags with null globalDefaults → present keys used, absent keys false",
  () => {
    const result = evaluateCookieFlags({ functional: true }, null);
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, false);
  }
);

// ── Suite 3: String-to-boolean coercion ───────────────────────────────────────

console.log("\n[Suite 3] String-to-boolean type coercion");

runTest(
  '"true" / "false" strings in userFlags coerce to correct booleans',
  () => {
    const result = evaluateCookieFlags(
      { functional: "true", analytics: "false", marketing: "true" },
      {}
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, true);
  }
);

runTest(
  '"TRUE" / "FALSE" uppercase strings are coerced correctly',
  () => {
    const result = evaluateCookieFlags(
      { functional: "TRUE", analytics: "FALSE", marketing: "TRUE" },
      {}
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, true);
  }
);

runTest(
  '"  True  " with surrounding whitespace is coerced correctly',
  () => {
    const result = evaluateCookieFlags(
      { functional: "  True  ", analytics: "  False  ", marketing: "  TRUE  " },
      {}
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, true);
  }
);

runTest(
  "user string \"true\" beats a boolean false in globalDefaults",
  () => {
    const result = evaluateCookieFlags(
      { analytics: "true" },
      { functional: false, analytics: false, marketing: false }
    );
    assert.strictEqual(result.analytics, true,
      "coerced user string should take priority over boolean default");
  }
);

runTest(
  "unrecognised string in userFlags falls back to globalDefault",
  () => {
    const result = evaluateCookieFlags(
      { functional: "maybe", analytics: "yes", marketing: "1" },
      { functional: true, analytics: false, marketing: true }
    );
    assert.strictEqual(result.functional, true,  '"maybe" is unrecognised → default true');
    assert.strictEqual(result.analytics, false,  '"yes" is unrecognised → default false');
    assert.strictEqual(result.marketing, true,   '"1" is unrecognised → default true');
  }
);

runTest(
  "string coercion works equally in globalDefaults layer",
  () => {
    const result = evaluateCookieFlags(
      {},
      { functional: "true", analytics: "false", marketing: "true" }
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, true);
  }
);

// ── Suite 4: Structural error handling — malformed / invalid inputs ───────────

console.log("\n[Suite 4] Structural error handling — malformed / invalid inputs");

runTest(
  "numeric values in userFlags fall back to globalDefaults, no throw",
  () => {
    const result = evaluateCookieFlags(
      { functional: 1, analytics: 0, marketing: 1 },
      { functional: false, analytics: true, marketing: false }
    );
    assert.strictEqual(result.functional, false, "1 is not boolean → falls to default false");
    assert.strictEqual(result.analytics, true,   "0 is not boolean → falls to default true");
    assert.strictEqual(result.marketing, false,  "1 is not boolean → falls to default false");
  }
);

runTest(
  "array userFlags treated as empty object → defaults applied, no throw",
  () => {
    const result = evaluateCookieFlags(
      [],
      { functional: true, analytics: false, marketing: true }
    );
    assert.deepStrictEqual(result, {
      functional: true,
      analytics: false,
      marketing: true,
    });
  }
);

runTest(
  "string userFlags treated as empty object → defaults applied, no throw",
  () => {
    const result = evaluateCookieFlags(
      "all-on",
      { functional: true, analytics: true, marketing: false }
    );
    assert.deepStrictEqual(result, {
      functional: true,
      analytics: true,
      marketing: false,
    });
  }
);

runTest(
  "numeric userFlags treated as empty object → all keys fall to safe false",
  () => {
    const result = evaluateCookieFlags(42, null);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics: false,
      marketing: false,
    });
  }
);

runTest(
  "undefined userFlags treated as empty object — does not throw",
  () => {
    const result = evaluateCookieFlags(
      undefined,
      { functional: true, analytics: false, marketing: false }
    );
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics, false);
  }
);

runTest(
  "nested object as flag value falls back to default, no throw",
  () => {
    const result = evaluateCookieFlags(
      { functional: { enabled: true }, analytics: false, marketing: true },
      { functional: false, analytics: false, marketing: false }
    );
    assert.strictEqual(result.functional, false,
      "object value is not boolean/string → falls to default");
    assert.strictEqual(result.analytics, false);
    assert.strictEqual(result.marketing, true);
  }
);

runTest(
  "null as individual flag value falls back to default, no throw",
  () => {
    const result = evaluateCookieFlags(
      { functional: null, analytics: null, marketing: true },
      { functional: true, analytics: true, marketing: false }
    );
    assert.strictEqual(result.functional, true,  "null → falls to default true");
    assert.strictEqual(result.analytics, true,   "null → falls to default true");
    assert.strictEqual(result.marketing, true,   "boolean true from user respected");
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Cookie consent evaluation contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
