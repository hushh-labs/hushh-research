"use strict";

/**
 * Canonical unit test for src/utils/privacy/domainFilter.js
 *
 * Requires and exercises the real production module — no mocks, no stubs.
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { filterWhitelistedDomains } = require("./domainFilter");

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

// ── Suite 1: Standard domain filtering — mixed compliant / non-compliant ──────

console.log("\n[Suite 1] Standard domain filtering — mixed compliant / non-compliant");

runTest(
  "only whitelist-approved domains are returned from a mixed input array",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai", "evil.com", "hushh.io", "malicious.net"],
      ["hushh.ai", "hushh.io"]
    );
    assert.deepStrictEqual(result, ["hushh.ai", "hushh.io"]);
  }
);

runTest(
  "when all domains match the whitelist, all are returned",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai", "api.hushh.ai", "hushh.io"],
      ["hushh.ai", "api.hushh.ai", "hushh.io"]
    );
    assert.deepStrictEqual(result, ["hushh.ai", "api.hushh.ai", "hushh.io"]);
  }
);

runTest(
  "when no domains match the whitelist, an empty array is returned",
  () => {
    const result = filterWhitelistedDomains(
      ["evil.com", "tracker.io", "spy.net"],
      ["hushh.ai", "hushh.io"]
    );
    assert.deepStrictEqual(result, []);
  }
);

runTest(
  "filtered result preserves original input order",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai", "bad.com", "hushh.io", "worse.net", "api.hushh.ai"],
      ["api.hushh.ai", "hushh.io", "hushh.ai"]
    );
    // Order must follow the domainArray sequence, not the whitelist sequence
    assert.deepStrictEqual(result, ["hushh.ai", "hushh.io", "api.hushh.ai"]);
  }
);

runTest(
  "a single matching domain among many is correctly isolated",
  () => {
    const result = filterWhitelistedDomains(
      ["evil1.com", "evil2.com", "hushh.ai", "evil3.com"],
      ["hushh.ai"]
    );
    assert.deepStrictEqual(result, ["hushh.ai"]);
  }
);

// ── Suite 2: Case-insensitive matching ────────────────────────────────────────

console.log("\n[Suite 2] Case-insensitive matching");

runTest(
  "UPPER-CASE domain matches lower-case whitelist entry",
  () => {
    const result = filterWhitelistedDomains(
      ["HUSHH.AI"],
      ["hushh.ai"]
    );
    assert.deepStrictEqual(result, ["HUSHH.AI"],
      "Original case must be preserved in the output");
  }
);

runTest(
  "lower-case domain matches UPPER-CASE whitelist entry",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai"],
      ["HUSHH.AI"]
    );
    assert.deepStrictEqual(result, ["hushh.ai"]);
  }
);

runTest(
  "mixed-case domain matches mixed-case whitelist entry regardless of casing",
  () => {
    const result = filterWhitelistedDomains(
      ["Hushh.Ai", "Evil.COM", "API.Hushh.AI"],
      ["hushh.ai", "api.hushh.ai"]
    );
    assert.deepStrictEqual(result, ["Hushh.Ai", "API.Hushh.AI"]);
  }
);

runTest(
  "case normalisation does not mutate the returned string values",
  () => {
    const input  = ["HUSHH.IO", "hushh.AI"];
    const result = filterWhitelistedDomains(input, ["hushh.io", "hushh.ai"]);
    assert.strictEqual(result[0], "HUSHH.IO",
      "Returned value must be the trimmed original, not a lowercased copy");
    assert.strictEqual(result[1], "hushh.AI");
  }
);

// ── Suite 3: Whitespace trimming ──────────────────────────────────────────────

console.log("\n[Suite 3] Whitespace trimming");

runTest(
  "domain with leading/trailing spaces is trimmed and matched",
  () => {
    const result = filterWhitelistedDomains(
      ["  hushh.ai  "],
      ["hushh.ai"]
    );
    assert.deepStrictEqual(result, ["hushh.ai"],
      "Whitespace-padded input must be trimmed in the output");
  }
);

runTest(
  "whitelist entry with surrounding spaces is trimmed before lookup",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai"],
      ["  hushh.ai  "]
    );
    assert.deepStrictEqual(result, ["hushh.ai"]);
  }
);

runTest(
  "whitespace trimming and case normalisation work together",
  () => {
    const result = filterWhitelistedDomains(
      ["  HUSHH.AI  ", "  Evil.COM  "],
      ["hushh.ai"]
    );
    assert.deepStrictEqual(result, ["HUSHH.AI"],
      "Trimmed and lowercased HUSHH.AI must match; Evil.COM must be rejected");
  }
);

runTest(
  "whitespace-only domain string is never matched or returned",
  () => {
    const result = filterWhitelistedDomains(
      ["   ", "\t", "\n"],
      ["hushh.ai", ""]
    );
    assert.deepStrictEqual(result, [],
      "Blank/whitespace-only strings must not be included in output");
  }
);

runTest(
  "internal whitespace within a domain is preserved (not collapsed)",
  () => {
    // "hushh .ai" has an internal space — it should NOT match "hushh.ai"
    const result = filterWhitelistedDomains(
      ["hushh .ai"],
      ["hushh.ai"]
    );
    assert.deepStrictEqual(result, [],
      "Only leading/trailing whitespace is stripped — internal spaces are kept");
  }
);

// ── Suite 4: Safe fallback — null, non-array, and malformed inputs ────────────

console.log("\n[Suite 4] Safe fallback — null / non-array / malformed inputs");

runTest(
  "null domainArray → empty array, no throw",
  () => assert.deepStrictEqual(filterWhitelistedDomains(null, ["hushh.ai"]), [])
);

runTest(
  "null allowedWhitelist → empty array, no throw",
  () => assert.deepStrictEqual(filterWhitelistedDomains(["hushh.ai"], null), [])
);

runTest(
  "both arguments null → empty array, no throw",
  () => assert.deepStrictEqual(filterWhitelistedDomains(null, null), [])
);

runTest(
  "undefined domainArray → empty array, no throw",
  () => assert.deepStrictEqual(filterWhitelistedDomains(undefined, ["hushh.ai"]), [])
);

runTest(
  "string passed as domainArray → empty array, no throw",
  () => assert.deepStrictEqual(filterWhitelistedDomains("hushh.ai", ["hushh.ai"]), [])
);

runTest(
  "object passed as allowedWhitelist → empty array, no throw",
  () => assert.deepStrictEqual(filterWhitelistedDomains(["hushh.ai"], { 0: "hushh.ai" }), [])
);

runTest(
  "non-string elements in domainArray are skipped; valid strings still filtered",
  () => {
    const result = filterWhitelistedDomains(
      [42, null, "hushh.ai", true, "evil.com", undefined, "hushh.io"],
      ["hushh.ai", "hushh.io"]
    );
    assert.deepStrictEqual(result, ["hushh.ai", "hushh.io"],
      "Numbers, booleans, null, and undefined in domainArray must be silently skipped");
  }
);

runTest(
  "non-string elements in allowedWhitelist are skipped; string entries still used",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai", "evil.com"],
      [99, null, "hushh.ai", true, undefined]
    );
    assert.deepStrictEqual(result, ["hushh.ai"],
      "Only string entries in the whitelist are used for comparison");
  }
);

runTest(
  "empty domainArray → empty array",
  () => assert.deepStrictEqual(filterWhitelistedDomains([], ["hushh.ai"]), [])
);

runTest(
  "empty allowedWhitelist → empty array",
  () => assert.deepStrictEqual(filterWhitelistedDomains(["hushh.ai"], []), [])
);

runTest(
  "both empty arrays → empty array",
  () => assert.deepStrictEqual(filterWhitelistedDomains([], []), [])
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Domain whitelist filter contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
