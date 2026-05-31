"use strict";

/**
 * Canonical unit test for src/utils/privacy/stringMasker.js
 *
 * Exercises the real production module directly — no mocks, no stubs.
 * Exits with code 0 when all assertions pass; code 1 on any failure.
 */

const assert = require("assert");
const { maskUserIdentifier } = require("./stringMasker");

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

// ── Suite 1: Standard email masking ──────────────────────────────────────────

console.log("\n[Suite 1] Standard email masking");

runTest(
  '"abdulgaffar@hushh.ai" → "a***r@hushh.ai"',
  () => assert.strictEqual(
    maskUserIdentifier("abdulgaffar@hushh.ai"),
    "a***r@hushh.ai"
  )
);

runTest(
  '"jane.doe@hushh.ai" (with surrounding whitespace) → "j***e@hushh.ai"',
  () => assert.strictEqual(
    maskUserIdentifier("  jane.doe@hushh.ai  "),
    "j***e@hushh.ai"
  )
);

runTest(
  "domain part is preserved verbatim after masking",
  () => {
    const result = maskUserIdentifier("user@sub.domain.org");
    assert.ok(
      result.endsWith("@sub.domain.org"),
      `Expected domain preserved in: ${result}`
    );
  }
);

runTest(
  "local part collapses to first + *** + last character only",
  () => {
    const result = maskUserIdentifier("longusername@example.com");
    const [local] = result.split("@");
    assert.match(local, /^[a-z]\*{3}[a-z]$/i, `Unexpected local mask shape: ${local}`);
  }
);

// ── Suite 2: Short email edge cases ──────────────────────────────────────────

console.log("\n[Suite 2] Short email edge cases");

runTest(
  'two-char local "ab@hushh.ai" → "a***@hushh.ai"',
  () => assert.strictEqual(
    maskUserIdentifier("ab@hushh.ai"),
    "a***@hushh.ai"
  )
);

runTest(
  'single-char local "a@hushh.ai" → "a***@hushh.ai"',
  () => assert.strictEqual(
    maskUserIdentifier("a@hushh.ai"),
    "a***@hushh.ai"
  )
);

runTest(
  "three-char local still shows both boundary chars",
  () => assert.strictEqual(
    maskUserIdentifier("abc@hushh.ai"),
    "a***c@hushh.ai"
  )
);

// ── Suite 3: Phone / numeric identifier masking ───────────────────────────────

console.log("\n[Suite 3] Phone / numeric identifier masking");

runTest(
  '"1234567890" → "******7890" (all but last 4 replaced)',
  () => assert.strictEqual(
    maskUserIdentifier("1234567890"),
    "******7890"
  )
);

runTest(
  "E.164 phone → last 4 digits of digit sequence preserved",
  () => {
    const result = maskUserIdentifier("+15551234567");
    assert.ok(result.endsWith("4567"), `Expected last 4 digits "4567", got: ${result}`);
    assert.ok(result.includes("*"), "Expected mask stars to be present");
  }
);

runTest(
  "exactly 4-digit value → fully masked to ****",
  () => assert.strictEqual(
    maskUserIdentifier("1234"),
    "****"
  )
);

runTest(
  "fewer than 4 digits → fully masked",
  () => assert.strictEqual(
    maskUserIdentifier("999"),
    "***"
  )
);

// ── Suite 4: Bad parameter safety / type guards ───────────────────────────────

console.log("\n[Suite 4] Bad parameter safety (null / undefined / non-string inputs)");

runTest(
  "null → returns empty string without throwing",
  () => assert.strictEqual(maskUserIdentifier(null), "")
);

runTest(
  "undefined → returns empty string without throwing",
  () => assert.strictEqual(maskUserIdentifier(undefined), "")
);

runTest(
  "number input → returns empty string without throwing",
  () => assert.strictEqual(maskUserIdentifier(42), "")
);

runTest(
  "object input → returns empty string without throwing",
  () => assert.strictEqual(maskUserIdentifier({ email: "user@hushh.ai" }), "")
);

runTest(
  "array input → returns empty string without throwing",
  () => assert.strictEqual(maskUserIdentifier(["user@hushh.ai"]), "")
);

runTest(
  "boolean input → returns empty string without throwing",
  () => assert.strictEqual(maskUserIdentifier(true), "")
);

runTest(
  "empty string → returns empty string",
  () => assert.strictEqual(maskUserIdentifier(""), "")
);

runTest(
  "whitespace-only string → returns empty string",
  () => assert.strictEqual(maskUserIdentifier("   "), "")
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Privacy masking contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
