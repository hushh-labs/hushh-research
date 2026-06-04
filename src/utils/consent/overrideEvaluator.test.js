"use strict";

/**
 * Canonical unit test for src/utils/consent/overrideEvaluator.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { resolveConsentState } = require("./overrideEvaluator");

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

// ── Suite 1: localOverride is explicit boolean — absolute precedence ──────────
//
// When localOverride is a boolean it MUST win regardless of globalStatus.
// The critical security case is (true, false) → false: a local revocation
// cannot be bypassed by a global grant.

console.log("\n[Suite 1] localOverride is explicit boolean — takes absolute precedence");

runTest(
  "resolveConsentState(true,  true)  → true  (both grant, override wins)",
  () => assert.strictEqual(resolveConsentState(true,  true),  true)
);

runTest(
  "resolveConsentState(false, true)  → true  (global denies, local grants)",
  () => assert.strictEqual(resolveConsentState(false, true),  true)
);

runTest(
  "resolveConsentState(true,  false) → false (global grants, local REVOKES — critical security case)",
  () => assert.strictEqual(resolveConsentState(true,  false), false)
);

runTest(
  "resolveConsentState(false, false) → false (both deny, override wins)",
  () => assert.strictEqual(resolveConsentState(false, false), false)
);

runTest(
  "resolveConsentState(undefined, true)  → true  (no global, local grants)",
  () => assert.strictEqual(resolveConsentState(undefined, true),  true)
);

runTest(
  "resolveConsentState(undefined, false) → false (no global, local denies)",
  () => assert.strictEqual(resolveConsentState(undefined, false), false)
);

runTest(
  "resolveConsentState(null, true)  → true  (null global, local grants)",
  () => assert.strictEqual(resolveConsentState(null, true),  true)
);

runTest(
  "resolveConsentState(null, false) → false (null global, local denies)",
  () => assert.strictEqual(resolveConsentState(null, false), false)
);

// ── Suite 2: localOverride absent/null/undefined — falls back to globalStatus ─

console.log("\n[Suite 2] localOverride absent/null/undefined — falls back to globalStatus");

runTest(
  "resolveConsentState(true,  null)      → true  (no override, global grants)",
  () => assert.strictEqual(resolveConsentState(true,  null),      true)
);

runTest(
  "resolveConsentState(false, null)      → false (no override, global denies)",
  () => assert.strictEqual(resolveConsentState(false, null),      false)
);

runTest(
  "resolveConsentState(true,  undefined) → true  (no override, global grants)",
  () => assert.strictEqual(resolveConsentState(true,  undefined), true)
);

runTest(
  "resolveConsentState(false, undefined) → false (no override, global denies)",
  () => assert.strictEqual(resolveConsentState(false, undefined), false)
);

runTest(
  "resolveConsentState(true)             → true  (single-arg, global grants)",
  () => assert.strictEqual(resolveConsentState(true),             true)
);

runTest(
  "resolveConsentState(false)            → false (single-arg, global denies)",
  () => assert.strictEqual(resolveConsentState(false),            false)
);

// ── Suite 3: Both absent or non-boolean — default-deny false ─────────────────

console.log("\n[Suite 3] Both absent or non-boolean — default-deny → false");

runTest(
  "resolveConsentState()                → false (no args — default-deny)",
  () => assert.strictEqual(resolveConsentState(),                  false)
);

runTest(
  "resolveConsentState(null, null)      → false",
  () => assert.strictEqual(resolveConsentState(null,      null),   false)
);

runTest(
  "resolveConsentState(undefined, undefined) → false",
  () => assert.strictEqual(resolveConsentState(undefined, undefined), false)
);

runTest(
  "resolveConsentState(null)            → false (null global, no override)",
  () => assert.strictEqual(resolveConsentState(null),              false)
);

runTest(
  "resolveConsentState(undefined)       → false (undefined global, no override)",
  () => assert.strictEqual(resolveConsentState(undefined),         false)
);

// ── Suite 4: Non-boolean globalStatus — not treated as consent signal ─────────

console.log("\n[Suite 4] Non-boolean globalStatus with no override → default-deny false");

runTest(
  'resolveConsentState("true",  null) → false (string not a boolean)',
  () => assert.strictEqual(resolveConsentState("true",  null), false)
);

runTest(
  'resolveConsentState("false", null) → false (string not a boolean)',
  () => assert.strictEqual(resolveConsentState("false", null), false)
);

runTest(
  "resolveConsentState(1, null)       → false (number 1 not a boolean)",
  () => assert.strictEqual(resolveConsentState(1,       null), false)
);

runTest(
  "resolveConsentState(0, null)       → false (number 0 not a boolean)",
  () => assert.strictEqual(resolveConsentState(0,       null), false)
);

runTest(
  "resolveConsentState({}, null)      → false (object not a boolean)",
  () => assert.strictEqual(resolveConsentState({},      null), false)
);

runTest(
  "resolveConsentState([], null)      → false (array not a boolean)",
  () => assert.strictEqual(resolveConsentState([],      null), false)
);

// ── Suite 5: Non-boolean localOverride — falls through to globalStatus ────────

console.log("\n[Suite 5] Non-boolean localOverride — falls through to globalStatus");

runTest(
  'resolveConsentState(true,  "true") → true  (string override ignored → global true)',
  () => assert.strictEqual(resolveConsentState(true,  "true"), true)
);

runTest(
  'resolveConsentState(false, "true") → false (string override ignored → global false)',
  () => assert.strictEqual(resolveConsentState(false, "true"), false)
);

runTest(
  "resolveConsentState(true,  1)      → true  (number 1 override ignored → global true)",
  () => assert.strictEqual(resolveConsentState(true,  1),      true)
);

runTest(
  "resolveConsentState(false, 0)      → false (number 0 override ignored → global false)",
  () => assert.strictEqual(resolveConsentState(false, 0),      false)
);

runTest(
  "resolveConsentState(true,  {})     → true  (object override ignored → global true)",
  () => assert.strictEqual(resolveConsentState(true,  {}),     true)
);

runTest(
  "resolveConsentState(true,  [])     → true  (array override ignored → global true)",
  () => assert.strictEqual(resolveConsentState(true,  []),     true)
);

// ── Suite 6: Return type is always strict boolean ─────────────────────────────

console.log("\n[Suite 6] Return type is always strict boolean (not truthy/falsy)");

runTest(
  "local override true  → typeof result === 'boolean' and === true",
  () => {
    const result = resolveConsentState(false, true);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, true);
  }
);

runTest(
  "local override false → typeof result === 'boolean' and === false",
  () => {
    const result = resolveConsentState(true, false);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

runTest(
  "global fallback true  → typeof result === 'boolean' and === true",
  () => {
    const result = resolveConsentState(true, null);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, true);
  }
);

runTest(
  "global fallback false → typeof result === 'boolean' and === false",
  () => {
    const result = resolveConsentState(false, null);
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

runTest(
  "default-deny        → typeof result === 'boolean' and === false",
  () => {
    const result = resolveConsentState();
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

// ── Suite 7: Security invariant — local revocation cannot be bypassed ─────────
//
// A local explicit `false` MUST override a global `true` in every combination.
// This suite isolates and stress-tests that single invariant so a future
// refactor that accidentally introduces coercion cannot slip past review.

console.log("\n[Suite 7] Security invariant — local false revocation overrides global true");

const revocationCases = [
  ["globalStatus=true,  localOverride=false",  true,  false, false],
  ["globalStatus=true,  localOverride=false (repeat)", true, false, false],
];

for (const [label, global, local, expected] of revocationCases) {
  runTest(
    `${label} → ${expected}`,
    () => assert.strictEqual(resolveConsentState(global, local), expected)
  );
}

// Verify the inverse: local true DOES override global false (grant path)
runTest(
  "globalStatus=false, localOverride=true  → true  (local grant overrides global deny)",
  () => assert.strictEqual(resolveConsentState(false, true), true)
);

// Verify neither direction coerces the local value
runTest(
  "local false is not coerced to global value (true) by any implicit cast",
  () => {
    const result = resolveConsentState(true, false);
    assert.notStrictEqual(result, true,
      "local false was coerced to global true — cascade is broken");
    assert.strictEqual(result, false);
  }
);

runTest(
  "local true is not coerced to global value (false) by any implicit cast",
  () => {
    const result = resolveConsentState(false, true);
    assert.notStrictEqual(result, false,
      "local true was coerced to global false — cascade is broken");
    assert.strictEqual(result, true);
  }
);

// ── Suite 8: Cascade exhaustion table ─────────────────────────────────────────
//
// Tabular sweep of all four boolean × boolean combinations confirms that the
// cascade resolves correctly in every case without relying on a single test.

console.log("\n[Suite 8] Cascade exhaustion — all boolean × boolean input pairs");

const exhaustionTable = [
  // [globalStatus, localOverride, expected, reason]
  [true,  true,  true,  "both grant — local wins"],
  [true,  false, false, "global grants, local revokes — local wins"],
  [false, true,  true,  "global denies, local grants — local wins"],
  [false, false, false, "both deny — local wins"],
];

for (const [global, local, expected, reason] of exhaustionTable) {
  runTest(
    `(${String(global).padEnd(5)}, ${String(local).padEnd(5)}) → ${expected} — ${reason}`,
    () => assert.strictEqual(
      resolveConsentState(global, local),
      expected,
      `Failed for globalStatus=${global}, localOverride=${local}`
    )
  );
}

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent override cascade contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
