"use strict";

/**
 * Canonical unit test for src/utils/consent/stateCompactor.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { compactConsentFlags } = require("./stateCompactor");

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

// ── Suite 1: Exact bitwise output — all flag combinations ─────────────────────

console.log("\n[Suite 1] Exact bitwise integer output for all 8 flag combinations");

runTest(
  "all true  → 7  (0b111 — full consent granted)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: true, analytics: true, marketing: true }),
    7
  )
);

runTest(
  "all false → 0  (0b000 — maximum-restriction posture)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: false, analytics: false, marketing: false }),
    0
  )
);

runTest(
  "functional=true,  analytics=false, marketing=true  → 5  (0b101)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: true, analytics: false, marketing: true }),
    5
  )
);

runTest(
  "functional=true,  analytics=true,  marketing=false → 6  (0b110)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: true, analytics: true, marketing: false }),
    6
  )
);

runTest(
  "functional=true,  analytics=false, marketing=false → 4  (0b100)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: true, analytics: false, marketing: false }),
    4
  )
);

runTest(
  "functional=false, analytics=true,  marketing=true  → 3  (0b011)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: false, analytics: true, marketing: true }),
    3
  )
);

runTest(
  "functional=false, analytics=true,  marketing=false → 2  (0b010)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: false, analytics: true, marketing: false }),
    2
  )
);

runTest(
  "functional=false, analytics=false, marketing=true  → 1  (0b001)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: false, analytics: false, marketing: true }),
    1
  )
);

// ── Suite 2: Missing keys default to 0 (secure posture) ───────────────────────

console.log("\n[Suite 2] Missing keys default to 0 (secure fallback)");

runTest(
  "empty object {} → 0 (all keys missing → all bits 0)",
  () => assert.strictEqual(compactConsentFlags({}), 0)
);

runTest(
  "only functional:true provided → 4 (analytics + marketing missing → 0)",
  () => assert.strictEqual(
    compactConsentFlags({ functional: true }),
    4
  )
);

runTest(
  "only marketing:true provided → 1 (functional + analytics missing → 0)",
  () => assert.strictEqual(
    compactConsentFlags({ marketing: true }),
    1
  )
);

runTest(
  "unknown extra key does not corrupt the result",
  () => assert.strictEqual(
    compactConsentFlags({ functional: true, unknown: true, analytics: false, marketing: true }),
    5,
    "Extra keys must be ignored — result must still be 0b101"
  )
);

// ── Suite 3: Type-safety and safe-fallback inputs ─────────────────────────────

console.log("\n[Suite 3] Null / undefined / non-object inputs → 0 without throwing");

runTest(
  "null → 0",
  () => assert.strictEqual(compactConsentFlags(null), 0)
);

runTest(
  "undefined → 0",
  () => assert.strictEqual(compactConsentFlags(undefined), 0)
);

runTest(
  "array input → 0",
  () => assert.strictEqual(compactConsentFlags([true, true, true]), 0)
);

runTest(
  "string input → 0",
  () => assert.strictEqual(compactConsentFlags("all-on"), 0)
);

runTest(
  "number input → 0",
  () => assert.strictEqual(compactConsentFlags(7), 0)
);

runTest(
  "boolean input → 0",
  () => assert.strictEqual(compactConsentFlags(true), 0)
);

// ── Suite 4: Non-boolean flag values treated as Boolean(value) ────────────────

console.log("\n[Suite 4] Non-boolean truthy/falsy values are coerced to Boolean");

runTest(
  "truthy string 'yes' for functional counts as true → bit 2 set",
  () => assert.strictEqual(
    compactConsentFlags({ functional: "yes", analytics: false, marketing: false }),
    4
  )
);

runTest(
  "falsy 0 for analytics counts as false → bit 1 not set",
  () => assert.strictEqual(
    compactConsentFlags({ functional: false, analytics: 0, marketing: true }),
    1
  )
);

runTest(
  "truthy 1 for marketing counts as true → bit 0 set",
  () => assert.strictEqual(
    compactConsentFlags({ functional: false, analytics: false, marketing: 1 }),
    1
  )
);

runTest(
  "null individual flag value counts as false",
  () => assert.strictEqual(
    compactConsentFlags({ functional: null, analytics: true, marketing: null }),
    2
  )
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent state compactor contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
