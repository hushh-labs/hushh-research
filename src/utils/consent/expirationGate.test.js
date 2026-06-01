"use strict";

/**
 * Canonical unit test for src/utils/consent/expirationGate.js
 *
 * Proves that isConsentTokenExpired and parseTokenExpiry correctly implement
 * the same expiry contract as consent-protocol/hushh_mcp/consent/token.py
 * → validate_token():  int(time.time() * 1000) >= int(expires_at_str)
 *
 * All timestamps are derived from Date.now() at runtime — no hard-coded
 * values that can become stale.
 *
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { isConsentTokenExpired, parseTokenExpiry } = require("./expirationGate");

const ONE_HOUR_MS  = 60 * 60 * 1000;
const ONE_DAY_MS   = 24 * ONE_HOUR_MS;

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

// ── Suite 1: isConsentTokenExpired — mirrors Python validate_token() contract ─

console.log("\n[Suite 1] isConsentTokenExpired — Python validate_token() contract");

runTest(
  "token expiring 1 hour from now is NOT expired (Date.now() < expiresAt)",
  () => {
    const expiresAt = Date.now() + ONE_HOUR_MS;
    assert.strictEqual(isConsentTokenExpired(expiresAt), false,
      "A future expiresAt must return false — mirrors Python: time.time()*1000 < expires_at");
  }
);

runTest(
  "token that expired 1 hour ago IS expired (Date.now() >= expiresAt)",
  () => {
    const expiresAt = Date.now() - ONE_HOUR_MS;
    assert.strictEqual(isConsentTokenExpired(expiresAt), true,
      "A past expiresAt must return true — mirrors Python: time.time()*1000 >= expires_at");
  }
);

runTest(
  "token expiring 24 hours from now is NOT expired",
  () => {
    assert.strictEqual(isConsentTokenExpired(Date.now() + ONE_DAY_MS), false);
  }
);

runTest(
  "token that expired 24 hours ago IS expired",
  () => {
    assert.strictEqual(isConsentTokenExpired(Date.now() - ONE_DAY_MS), true);
  }
);

runTest(
  "token expiring 1 ms from now is NOT expired",
  () => {
    assert.strictEqual(isConsentTokenExpired(Date.now() + 1), false);
  }
);

runTest(
  "token that expired 1 ms ago IS expired — boundary is strict >=",
  () => {
    assert.strictEqual(isConsentTokenExpired(Date.now() - 1), true);
  }
);

// ── Suite 2: Seconds-format expiresAt (Python may return seconds on some paths)

console.log("\n[Suite 2] isConsentTokenExpired — seconds timestamp auto-detection");

runTest(
  "future expiresAt supplied in seconds is correctly detected as not expired",
  () => {
    const secondsTs = Math.floor((Date.now() + ONE_HOUR_MS) / 1000);
    assert.strictEqual(isConsentTokenExpired(secondsTs), false,
      "Seconds-format future timestamp must be auto-converted to ms before comparison");
  }
);

runTest(
  "past expiresAt supplied in seconds is correctly detected as expired",
  () => {
    const secondsTs = Math.floor((Date.now() - ONE_HOUR_MS) / 1000);
    assert.strictEqual(isConsentTokenExpired(secondsTs), true);
  }
);

// ── Suite 3: parseTokenExpiry — real token response shapes from JS routes ──────

console.log("\n[Suite 3] parseTokenExpiry — real token response shapes");

runTest(
  "camelCase { expiresAt } shape (session-token/route.ts) — valid future token",
  () => {
    const expiresAt = Date.now() + ONE_HOUR_MS;
    const result = parseTokenExpiry({ expiresAt });
    assert.strictEqual(result.isExpired, false);
    assert.strictEqual(result.expiresAt, expiresAt,
      "Parsed expiresAt must equal the input millisecond value");
  }
);

runTest(
  "camelCase { expiresAt } shape — expired token",
  () => {
    const expiresAt = Date.now() - ONE_HOUR_MS;
    const result = parseTokenExpiry({ expiresAt });
    assert.strictEqual(result.isExpired, true);
    assert.strictEqual(result.expiresAt, expiresAt);
  }
);

runTest(
  "snake_case { expires_at } shape (Python backend direct) — valid future token",
  () => {
    const expires_at = Date.now() + ONE_HOUR_MS;
    const result = parseTokenExpiry({ expires_at });
    assert.strictEqual(result.isExpired, false);
    assert.strictEqual(result.expiresAt, expires_at,
      "snake_case expires_at must be accepted as a fallback field name");
  }
);

runTest(
  "snake_case { expires_at } shape — expired token",
  () => {
    const expires_at = Date.now() - ONE_HOUR_MS;
    const result = parseTokenExpiry({ expires_at });
    assert.strictEqual(result.isExpired, true);
  }
);

runTest(
  "camelCase takes precedence when both expiresAt and expires_at are present",
  () => {
    const camel = Date.now() + ONE_HOUR_MS;   // future  → not expired
    const snake = Date.now() - ONE_HOUR_MS;   // past    → expired
    const result = parseTokenExpiry({ expiresAt: camel, expires_at: snake });
    assert.strictEqual(result.isExpired, false,
      "camelCase expiresAt must win over snake_case expires_at");
    assert.strictEqual(result.expiresAt, camel);
  }
);

runTest(
  "full session-token route response shape is correctly parsed",
  () => {
    // Shape returned by /api/consent/session-token after Python issues the token
    const mockSessionTokenResponse = {
      token:      "hushh_consent:abc123.sig456",
      userId:     "usr_hushh_2026",
      agentId:    "agent_kai",
      scope:      "session",
      issuedAt:   Date.now() - 60_000,          // issued 60 s ago
      expiresAt:  Date.now() + (8 * ONE_HOUR_MS), // expires in 8 hours
    };
    const result = parseTokenExpiry(mockSessionTokenResponse);
    assert.strictEqual(result.isExpired, false,
      "A freshly issued session token must not be expired");
    assert.ok(typeof result.expiresAt === "number" && result.expiresAt > Date.now(),
      "Parsed expiresAt must be a number greater than Date.now()");
  }
);

runTest(
  "full vault-owner-token route response shape is correctly parsed",
  () => {
    const mockVaultOwnerTokenResponse = {
      token:      "hushh_consent:xyz789.sigabc",
      userId:     "usr_abdulgaffar",
      agentId:    "agent_vault",
      scope:      "vault.owner",
      expiresAt:  Date.now() + (24 * ONE_HOUR_MS),
    };
    const result = parseTokenExpiry(mockVaultOwnerTokenResponse);
    assert.strictEqual(result.isExpired, false);
  }
);

runTest(
  "response with missing expiresAt field → { expiresAt: null, isExpired: true }",
  () => {
    const result = parseTokenExpiry({ token: "hushh_consent:abc.sig", scope: "session" });
    assert.strictEqual(result.expiresAt, null);
    assert.strictEqual(result.isExpired, true,
      "Missing expiresAt must default to expired — max-security fallback");
  }
);

runTest(
  "response with string expiresAt → { expiresAt: null, isExpired: true }",
  () => {
    const result = parseTokenExpiry({ expiresAt: "2026-06-01T00:00:00Z" });
    assert.strictEqual(result.expiresAt, null);
    assert.strictEqual(result.isExpired, true);
  }
);

// ── Suite 4: Safe fallback — null / invalid expiresAt and bad response shapes ─

console.log("\n[Suite 4] Safe fallback — null / invalid inputs and malformed responses");

runTest(
  "null expiresAt → true (max-security fallback)",
  () => assert.strictEqual(isConsentTokenExpired(null), true)
);

runTest(
  "undefined expiresAt → true",
  () => assert.strictEqual(isConsentTokenExpired(undefined), true)
);

runTest(
  "NaN expiresAt → true",
  () => assert.strictEqual(isConsentTokenExpired(NaN), true)
);

runTest(
  "Infinity expiresAt → true (non-finite boundary rejected)",
  () => assert.strictEqual(isConsentTokenExpired(Infinity), true)
);

runTest(
  "negative expiresAt → true (pre-epoch timestamp rejected)",
  () => assert.strictEqual(isConsentTokenExpired(-1), true)
);

runTest(
  "zero expiresAt → true (epoch is always expired)",
  () => assert.strictEqual(isConsentTokenExpired(0), true)
);

runTest(
  "string expiresAt → true",
  () => assert.strictEqual(isConsentTokenExpired("2026-06-01"), true)
);

runTest(
  "null tokenResponse to parseTokenExpiry → { expiresAt: null, isExpired: true }",
  () => {
    const result = parseTokenExpiry(null);
    assert.strictEqual(result.expiresAt, null);
    assert.strictEqual(result.isExpired, true);
  }
);

runTest(
  "array tokenResponse to parseTokenExpiry → { expiresAt: null, isExpired: true }",
  () => {
    const result = parseTokenExpiry([Date.now() + ONE_HOUR_MS]);
    assert.strictEqual(result.expiresAt, null);
    assert.strictEqual(result.isExpired, true);
  }
);

runTest(
  "string tokenResponse to parseTokenExpiry → { expiresAt: null, isExpired: true }",
  () => {
    const result = parseTokenExpiry("hushh_consent:abc.sig");
    assert.strictEqual(result.expiresAt, null);
    assert.strictEqual(result.isExpired, true);
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Consent token expiration gate contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
