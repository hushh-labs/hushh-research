"use strict";

/**
 * Canonical unit test for src/utils/privacy/domainFilter.js
 *
 * Exercises the real production module — no mocks, no stubs.
 * Primary focus: prove the WIRED filterOutboundDomains function enforces
 * the canonical ALLOWED_OUTBOUND_DOMAINS registry at the consent boundary.
 * Secondary: verify the pure filterWhitelistedDomains utility edge cases.
 *
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const {
  filterOutboundDomains,
  filterWhitelistedDomains,
  ALLOWED_OUTBOUND_DOMAINS,
} = require("./domainFilter");

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

// ── Suite 1: Registry integrity — canonical domain list is well-formed ────────

console.log("\n[Suite 1] Registry integrity — ALLOWED_OUTBOUND_DOMAINS is well-formed");

runTest(
  "ALLOWED_OUTBOUND_DOMAINS is exported as an array",
  () => assert.ok(Array.isArray(ALLOWED_OUTBOUND_DOMAINS),
    "Registry must be an array so filterOutboundDomains can consume it")
);

runTest(
  "every entry in ALLOWED_OUTBOUND_DOMAINS is a non-empty string",
  () => {
    for (const domain of ALLOWED_OUTBOUND_DOMAINS) {
      assert.strictEqual(typeof domain, "string",
        `Registry entry ${JSON.stringify(domain)} must be a string`);
      assert.ok(domain.trim().length > 0,
        `Registry entry ${JSON.stringify(domain)} must not be blank`);
    }
  }
);

runTest(
  "registry contains the canonical Hushh consent-boundary domains",
  () => {
    const registry = new Set(ALLOWED_OUTBOUND_DOMAINS);
    assert.ok(registry.has("hushh.ai"),         "hushh.ai must be in the registry");
    assert.ok(registry.has("api.hushh.ai"),     "api.hushh.ai must be in the registry");
    assert.ok(registry.has("consent.hushh.ai"), "consent.hushh.ai must be in the registry");
    assert.ok(registry.has("vault.hushh.ai"),   "vault.hushh.ai must be in the registry");
  }
);

runTest(
  "ALLOWED_OUTBOUND_DOMAINS is frozen — runtime mutation is rejected silently",
  () => {
    const lengthBefore = ALLOWED_OUTBOUND_DOMAINS.length;
    try { ALLOWED_OUTBOUND_DOMAINS.push("malicious.com"); } catch (_) { /* strict mode throws */ }
    assert.strictEqual(
      ALLOWED_OUTBOUND_DOMAINS.length,
      lengthBefore,
      "Registry must not grow after a push attempt — Object.freeze enforced"
    );
    assert.ok(
      !ALLOWED_OUTBOUND_DOMAINS.includes("malicious.com"),
      "Injected domain must not appear in the frozen registry"
    );
  }
);

// ── Suite 2: Wired routing — filterOutboundDomains enforces the registry ──────

console.log("\n[Suite 2] Wired routing — filterOutboundDomains enforces the canonical registry");

runTest(
  "every domain in ALLOWED_OUTBOUND_DOMAINS passes the wired filter",
  () => {
    const result = filterOutboundDomains([...ALLOWED_OUTBOUND_DOMAINS]);
    assert.deepStrictEqual(
      result.sort(),
      [...ALLOWED_OUTBOUND_DOMAINS].sort(),
      "All registry domains must pass through filterOutboundDomains unchanged"
    );
  }
);

runTest(
  "non-registry domain is blocked at the outbound boundary",
  () => {
    const result = filterOutboundDomains(["evil.com", "tracker.io", "spy.net"]);
    assert.deepStrictEqual(result, [],
      "Domains absent from the registry must be stripped at the boundary");
  }
);

runTest(
  "mixed array: registry domains pass, non-registry domains are stripped",
  () => {
    const result = filterOutboundDomains([
      "hushh.ai",
      "malicious.com",
      "api.hushh.ai",
      "tracker.io",
      "vault.hushh.ai",
    ]);
    assert.deepStrictEqual(result, ["hushh.ai", "api.hushh.ai", "vault.hushh.ai"]);
  }
);

runTest(
  "filterOutboundDomains preserves the input order of approved domains",
  () => {
    const result = filterOutboundDomains([
      "vault.hushh.ai",
      "bad.com",
      "consent.hushh.ai",
      "evil.net",
      "hushh.ai",
    ]);
    assert.deepStrictEqual(result, ["vault.hushh.ai", "consent.hushh.ai", "hushh.ai"]);
  }
);

runTest(
  "filterOutboundDomains accepts registry domains case-insensitively",
  () => {
    const result = filterOutboundDomains(["HUSHH.AI", "API.HUSHH.AI"]);
    assert.deepStrictEqual(result, ["HUSHH.AI", "API.HUSHH.AI"],
      "Case-variant registry domains must pass through with original casing preserved");
  }
);

runTest(
  "filterOutboundDomains strips whitespace before registry lookup",
  () => {
    const result = filterOutboundDomains(["  hushh.ai  ", "  evil.com  "]);
    assert.deepStrictEqual(result, ["hushh.ai"],
      "Padded registry domain must be trimmed and matched; non-registry must be stripped");
  }
);

runTest(
  "filterOutboundDomains returns [] for an empty input array",
  () => assert.deepStrictEqual(filterOutboundDomains([]), [])
);

runTest(
  "filterOutboundDomains returns [] for null input without throwing",
  () => assert.deepStrictEqual(filterOutboundDomains(null), [])
);

// ── Suite 3: Pure utility — filterWhitelistedDomains custom-whitelist cases ───

console.log("\n[Suite 3] Pure utility — filterWhitelistedDomains with custom whitelists");

runTest(
  "custom whitelist: only matching domains are returned",
  () => {
    const result = filterWhitelistedDomains(
      ["partner.hushh.ai", "evil.com", "cdn.hushh.ai"],
      ["partner.hushh.ai", "cdn.hushh.ai"]
    );
    assert.deepStrictEqual(result, ["partner.hushh.ai", "cdn.hushh.ai"]);
  }
);

runTest(
  "UPPER-CASE domain matches lower-case custom whitelist entry",
  () => {
    const result = filterWhitelistedDomains(["PARTNER.HUSHH.AI"], ["partner.hushh.ai"]);
    assert.deepStrictEqual(result, ["PARTNER.HUSHH.AI"]);
  }
);

runTest(
  "whitespace-padded domain is trimmed before matching custom whitelist",
  () => {
    const result = filterWhitelistedDomains(["  partner.hushh.ai  "], ["partner.hushh.ai"]);
    assert.deepStrictEqual(result, ["partner.hushh.ai"]);
  }
);

runTest(
  "internal whitespace in a domain is NOT trimmed — it prevents a match",
  () => {
    const result = filterWhitelistedDomains(["hushh .ai"], ["hushh.ai"]);
    assert.deepStrictEqual(result, []);
  }
);

// ── Suite 4: Safe fallback — null / non-array / malformed inputs ──────────────

console.log("\n[Suite 4] Safe fallback — malformed inputs to the pure utility");

runTest(
  "null domainArray → []",
  () => assert.deepStrictEqual(filterWhitelistedDomains(null, ["hushh.ai"]), [])
);

runTest(
  "null allowedWhitelist → []",
  () => assert.deepStrictEqual(filterWhitelistedDomains(["hushh.ai"], null), [])
);

runTest(
  "object passed as allowedWhitelist → []",
  () => assert.deepStrictEqual(filterWhitelistedDomains(["hushh.ai"], { 0: "hushh.ai" }), [])
);

runTest(
  "non-string elements in domainArray are skipped; valid strings still filtered",
  () => {
    const result = filterWhitelistedDomains(
      [42, null, "hushh.ai", true, "evil.com"],
      ["hushh.ai"]
    );
    assert.deepStrictEqual(result, ["hushh.ai"]);
  }
);

runTest(
  "non-string elements in allowedWhitelist are skipped; string entries still used",
  () => {
    const result = filterWhitelistedDomains(
      ["hushh.ai", "evil.com"],
      [99, null, "hushh.ai", true]
    );
    assert.deepStrictEqual(result, ["hushh.ai"]);
  }
);

runTest(
  "empty domainArray → []",
  () => assert.deepStrictEqual(filterWhitelistedDomains([], ["hushh.ai"]), [])
);

runTest(
  "empty allowedWhitelist → []",
  () => assert.deepStrictEqual(filterWhitelistedDomains(["hushh.ai"], []), [])
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Outbound domain consent boundary contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
