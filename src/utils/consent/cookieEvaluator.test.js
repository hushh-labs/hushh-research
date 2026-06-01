"use strict";

/**
 * Canonical unit test for src/utils/consent/cookieEvaluator.js
 *
 * Proves that resolveConsentFlags and evaluateCookieFlags correctly implement
 * the consent-flag resolution contract for the vault storage path:
 *
 *   resolveConsentFlags(userInput)
 *     → { functional, analytics, marketing }  (all explicit booleans)
 *     → encrypt(result)
 *     → storePreferences({
 *         userId,
 *         preferences: { cookie_flags: { ciphertext, iv, tag } },
 *         consentToken,
 *       })
 *     → POST /api/vault/store-preferences  (store-preferences/route.ts)
 *
 * Primary focus: resolveConsentFlags is wired to COOKIE_CONSENT_DEFAULTS
 *   (all false, privacy-by-default) and is the function callers MUST use
 *   before encrypting flags for vault persistence.
 * Secondary: evaluateCookieFlags pure-utility edge cases.
 *
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const {
  resolveConsentFlags,
  evaluateCookieFlags,
  COOKIE_CONSENT_DEFAULTS,
  KNOWN_FLAGS,
} = require("./cookieEvaluator");

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

// ── Suite 1: Registry integrity — COOKIE_CONSENT_DEFAULTS and KNOWN_FLAGS ────

console.log("\n[Suite 1] Registry integrity — COOKIE_CONSENT_DEFAULTS and KNOWN_FLAGS");

runTest(
  "COOKIE_CONSENT_DEFAULTS is exported as a plain object",
  () => assert.ok(
    COOKIE_CONSENT_DEFAULTS !== null &&
    typeof COOKIE_CONSENT_DEFAULTS === "object" &&
    !Array.isArray(COOKIE_CONSENT_DEFAULTS)
  )
);

runTest(
  "COOKIE_CONSENT_DEFAULTS carries false for all three known flags (privacy-by-default)",
  () => {
    assert.strictEqual(COOKIE_CONSENT_DEFAULTS.functional, false);
    assert.strictEqual(COOKIE_CONSENT_DEFAULTS.analytics,  false);
    assert.strictEqual(COOKIE_CONSENT_DEFAULTS.marketing,  false);
  }
);

runTest(
  "COOKIE_CONSENT_DEFAULTS is frozen — runtime mutation is rejected silently",
  () => {
    const before = COOKIE_CONSENT_DEFAULTS.functional;
    try { COOKIE_CONSENT_DEFAULTS.functional = true; } catch (_) {}
    assert.strictEqual(COOKIE_CONSENT_DEFAULTS.functional, before,
      "Frozen registry must not be mutated by a property assignment");
  }
);

runTest(
  "KNOWN_FLAGS contains exactly functional, analytics, and marketing",
  () => {
    assert.ok(KNOWN_FLAGS.includes("functional"));
    assert.ok(KNOWN_FLAGS.includes("analytics"));
    assert.ok(KNOWN_FLAGS.includes("marketing"));
    assert.strictEqual(KNOWN_FLAGS.length, 3,
      "KNOWN_FLAGS must contain exactly the three consent categories");
  }
);

// ── Suite 2: resolveConsentFlags — wired pre-vault-storage boundary ───────────

console.log("\n[Suite 2] resolveConsentFlags — wired pre-vault-storage boundary");

runTest(
  "all explicit booleans pass through — output is ready for vault encryption",
  () => {
    // This is the shape callers produce right before calling storePreferences
    const result = resolveConsentFlags({
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
  "partial user input — missing flags receive false from COOKIE_CONSENT_DEFAULTS",
  () => {
    // User only toggled functional; analytics and marketing not yet set
    const result = resolveConsentFlags({ functional: true });
    assert.strictEqual(result.functional, true,
      "Explicit boolean from user must be preserved");
    assert.strictEqual(result.analytics,  false,
      "Missing analytics must default to false (privacy-by-default)");
    assert.strictEqual(result.marketing,  false,
      "Missing marketing must default to false (privacy-by-default)");
  }
);

runTest(
  "empty object — all three flags default to false before vault write",
  () => {
    const result = resolveConsentFlags({});
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "null userFlags — returns all-false defaults, safe to encrypt and store",
  () => {
    const result = resolveConsentFlags(null);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "result always contains all three keys — safe to pass directly to encrypt()",
  () => {
    const result = resolveConsentFlags({});
    assert.ok("functional" in result, "functional key must be present");
    assert.ok("analytics"  in result, "analytics key must be present");
    assert.ok("marketing"  in result, "marketing key must be present");
    assert.strictEqual(Object.keys(result).length, 3,
      "Output must contain exactly the three consent keys — no unknown keys reach the vault");
  }
);

runTest(
  "unknown keys in user input are stripped — only known flags reach vault storage",
  () => {
    const result = resolveConsentFlags({
      functional: true,
      tracking:   true,   // unknown — must be stripped
      session:    true,   // unknown — must be stripped
    });
    assert.strictEqual("tracking" in result, false,
      "Unknown 'tracking' key must not reach vault storage");
    assert.strictEqual("session" in result, false,
      "Unknown 'session' key must not reach vault storage");
    assert.deepStrictEqual(Object.keys(result).sort(), ["analytics", "functional", "marketing"]);
  }
);

// ── Suite 3: String coercion — UI inputs before vault encryption ──────────────

console.log("\n[Suite 3] String coercion — UI form values resolved before vault encryption");

runTest(
  '"true"/"false" strings from form inputs coerce correctly before encrypt()',
  () => {
    const result = resolveConsentFlags({
      functional: "true",
      analytics:  "false",
      marketing:  "true",
    });
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  true);
  }
);

runTest(
  '"TRUE"/"FALSE" uppercase strings coerce correctly',
  () => {
    const result = resolveConsentFlags({
      functional: "TRUE",
      analytics:  "FALSE",
      marketing:  "TRUE",
    });
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.analytics,  false);
  }
);

runTest(
  'unrecognised string ("maybe", "yes", "1") falls back to false default',
  () => {
    const result = resolveConsentFlags({
      functional: "maybe",
      analytics:  "yes",
      marketing:  "1",
    });
    assert.strictEqual(result.functional, false,
      '"maybe" must fall through to the false default');
    assert.strictEqual(result.analytics,  false,
      '"yes" must fall through to the false default');
    assert.strictEqual(result.marketing,  false,
      '"1" must fall through to the false default');
  }
);

// ── Suite 4: evaluateCookieFlags — pure utility with caller-supplied defaults ─

console.log("\n[Suite 4] evaluateCookieFlags — pure utility with caller-supplied defaults");

runTest(
  "caller-supplied all-true defaults: missing user flags resolve to true",
  () => {
    const result = evaluateCookieFlags(
      {},
      { functional: true, analytics: true, marketing: true }
    );
    assert.deepStrictEqual(result, {
      functional: true,
      analytics:  true,
      marketing:  true,
    });
  }
);

runTest(
  "user boolean false overrides caller-supplied default of true",
  () => {
    const result = evaluateCookieFlags(
      { analytics: false },
      { functional: true, analytics: true, marketing: true }
    );
    assert.strictEqual(result.analytics, false,
      "Explicit user false must win over caller-supplied default true");
    assert.strictEqual(result.functional, true);
    assert.strictEqual(result.marketing,  true);
  }
);

runTest(
  "unknown keys in globalDefaults are also silently dropped",
  () => {
    const result = evaluateCookieFlags(
      {},
      { functional: false, analytics: false, marketing: false, unknown: true }
    );
    assert.strictEqual("unknown" in result, false);
  }
);

// ── Suite 5: Safe fallback — invalid inputs to both functions ─────────────────

console.log("\n[Suite 5] Safe fallback — invalid inputs");

runTest(
  "undefined input to resolveConsentFlags → all-false defaults, no throw",
  () => {
    const result = resolveConsentFlags(undefined);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "array input to resolveConsentFlags → all-false defaults, no throw",
  () => {
    const result = resolveConsentFlags([true, false, true]);
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

runTest(
  "numeric values for flags fall back to false default",
  () => {
    const result = resolveConsentFlags({
      functional: 1,
      analytics:  0,
      marketing:  1,
    });
    assert.strictEqual(result.functional, false,
      "Number 1 is not a boolean — falls through to false default");
    assert.strictEqual(result.analytics,  false);
    assert.strictEqual(result.marketing,  false);
  }
);

runTest(
  "null individual flag values fall back to false default",
  () => {
    const result = resolveConsentFlags({
      functional: null,
      analytics:  null,
      marketing:  null,
    });
    assert.deepStrictEqual(result, {
      functional: false,
      analytics:  false,
      marketing:  false,
    });
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Cookie consent flag resolution contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
