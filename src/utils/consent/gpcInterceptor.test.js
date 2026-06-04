"use strict";

/**
 * Canonical unit test for src/utils/consent/gpcInterceptor.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { parseGpcHeader } = require("./gpcInterceptor");

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

// ── Suite 1: Opt-out signal — header present with value "1" ──────────────────

console.log('\n[Suite 1] GPC opt-out active — header value "1" returns true');

runTest(
  'lowercase key "sec-gpc": "1" → true',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "1" }), true)
);

runTest(
  'title-case key "Sec-GPC": "1" → true',
  () => assert.strictEqual(parseGpcHeader({ "Sec-GPC": "1" }), true)
);

runTest(
  'uppercase key "SEC-GPC": "1" → true (full scan fallback)',
  () => assert.strictEqual(parseGpcHeader({ "SEC-GPC": "1" }), true)
);

runTest(
  'mixed-case key "Sec-Gpc": "1" → true (full scan fallback)',
  () => assert.strictEqual(parseGpcHeader({ "Sec-Gpc": "1" }), true)
);

runTest(
  'numeric value 1 (not string) → true',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": 1 }), true)
);

runTest(
  'header alongside unrelated headers, value "1" → true',
  () => assert.strictEqual(
    parseGpcHeader({
      "content-type": "application/json",
      "sec-gpc": "1",
      "authorization": "Bearer token",
    }),
    true
  )
);

// ── Suite 2: No opt-out — header present with value "0" or 0 ─────────────────

console.log('\n[Suite 2] GPC opt-out inactive — header present but value is "0"');

runTest(
  '"sec-gpc": "0" → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "0" }), false)
);

runTest(
  '"Sec-GPC": "0" → false',
  () => assert.strictEqual(parseGpcHeader({ "Sec-GPC": "0" }), false)
);

runTest(
  '"sec-gpc": 0 (numeric zero) → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": 0 }), false)
);

// ── Suite 3: No opt-out — header explicitly null or empty ────────────────────

console.log('\n[Suite 3] GPC header present but null / empty string → false');

runTest(
  '"sec-gpc": null → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": null }), false)
);

runTest(
  '"sec-gpc": "" (empty string) → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "" }), false)
);

runTest(
  '"sec-gpc": undefined → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": undefined }), false)
);

// ── Suite 4: No opt-out — header absent entirely ─────────────────────────────

console.log('\n[Suite 4] GPC header absent — returns false without throwing');

runTest(
  "empty headers object {} → false",
  () => assert.strictEqual(parseGpcHeader({}), false)
);

runTest(
  "headers with only unrelated keys → false",
  () => assert.strictEqual(
    parseGpcHeader({ "content-type": "application/json", "accept": "*/*" }),
    false
  )
);

runTest(
  "headers with 'sec-gpc' not present but 'sec-fetch-site' present → false",
  () => assert.strictEqual(
    parseGpcHeader({ "sec-fetch-site": "same-origin" }),
    false
  )
);

// ── Suite 5: Opt-out false for non-"1" string values ─────────────────────────

console.log('\n[Suite 5] Non-"1" string values → false');

runTest(
  '"sec-gpc": "true" (string, not "1") → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "true" }), false)
);

runTest(
  '"sec-gpc": "yes" → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "yes" }), false)
);

runTest(
  '"sec-gpc": "on" → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "on" }), false)
);

runTest(
  '"sec-gpc": "2" → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": "2" }), false)
);

runTest(
  '"sec-gpc": " 1" (leading space) → false',
  () => assert.strictEqual(parseGpcHeader({ "sec-gpc": " 1" }), false)
);

// ── Suite 6: Return type is always a strict boolean ──────────────────────────

console.log('\n[Suite 6] Return type is always strict boolean (not truthy/falsy)');

runTest(
  'opt-out result is strictly === true (boolean)',
  () => {
    const result = parseGpcHeader({ "sec-gpc": "1" });
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, true);
  }
);

runTest(
  'no-opt-out result is strictly === false (boolean)',
  () => {
    const result = parseGpcHeader({ "sec-gpc": "0" });
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

runTest(
  'absent header result is strictly === false (boolean)',
  () => {
    const result = parseGpcHeader({});
    assert.strictEqual(typeof result, "boolean",
      `Expected boolean, got ${typeof result}`);
    assert.strictEqual(result, false);
  }
);

// ── Suite 7: Defensive — invalid input types never throw ─────────────────────

console.log('\n[Suite 7] Null / undefined / non-object input — never throws, returns false');

runTest(
  "null input → false (no throw)",
  () => assert.strictEqual(parseGpcHeader(null), false)
);

runTest(
  "undefined input → false (no throw)",
  () => assert.strictEqual(parseGpcHeader(undefined), false)
);

runTest(
  "string input → false (no throw)",
  () => assert.strictEqual(parseGpcHeader("sec-gpc: 1"), false)
);

runTest(
  "number input → false (no throw)",
  () => assert.strictEqual(parseGpcHeader(1), false)
);

runTest(
  "array input → false (no throw)",
  () => assert.strictEqual(parseGpcHeader(["sec-gpc", "1"]), false)
);

runTest(
  "boolean input → false (no throw)",
  () => assert.strictEqual(parseGpcHeader(true), false)
);

// ── Suite 8: Both key casings coexist — first canonical match wins ────────────

console.log('\n[Suite 8] Both "sec-gpc" and "Sec-GPC" present — correct value resolved');

runTest(
  'lowercase "sec-gpc"="1" and "Sec-GPC"="0" — opt-out is true (lowercase wins)',
  () => assert.strictEqual(
    parseGpcHeader({ "sec-gpc": "1", "Sec-GPC": "0" }),
    true
  )
);

runTest(
  'lowercase "sec-gpc"="0" and "Sec-GPC"="1" — first canonical key "sec-gpc" resolves to false',
  () => assert.strictEqual(
    parseGpcHeader({ "sec-gpc": "0", "Sec-GPC": "1" }),
    false
  )
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` GPC interceptor contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
