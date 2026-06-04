"use strict";

/**
 * Purpose Gateway — request-boundary consent enforcement.
 *
 * This module wires `isPurposeValid` (purposeValidator.js) into a concrete
 * request handler so the validator is exercised on every inbound consent
 * request, not just in tests.  The coupling is the attach-point proof:
 * no consent payload reaches downstream processing without passing through
 * this gate.
 *
 * Attach-point:  processConsentRequest() is the entry point called by the
 *                route handler / API layer.  It calls isPurposeValid() at the
 *                trust boundary before any further action.
 *
 * Running this file directly:
 *   node src/utils/consent/purposeGateway.js
 *   Executes the built-in E2E proof block and exits 0 on full pass or 1 on
 *   any assertion failure.
 */

const { isPurposeValid } = require("./purposeValidator");

// ── Canonical approved purpose tiers ─────────────────────────────────────────
// This registry is the single source of truth for what the platform permits.
// Any purpose not listed here is rejected at the gate — no exceptions.
const APPROVED_PURPOSES = [
  "essential",       // core functionality required for service operation
  "analytics",       // aggregate usage analytics (no PII export)
  "marketing",       // opted-in promotional communications
  "personalization", // user-experience customisation
  "research",        // internal research with consent on file
];

// ── Response constructors ─────────────────────────────────────────────────────

function _allowed(purpose) {
  return { allowed: true,  purpose, reason: "purpose approved" };
}

function _blocked(purpose, reason) {
  return { allowed: false, purpose: purpose !== undefined ? purpose : null, reason };
}

/**
 * processConsentRequest(requestPayload)
 *
 * Intercepts an inbound consent request at the request boundary, validates the
 * declared purpose against the approved tier registry, and returns a structured
 * decision object.
 *
 * Decision object shape:
 *   {
 *     allowed : boolean  — true  if the request may proceed
 *     purpose : string | null  — the purpose that was evaluated
 *     reason  : string  — human-readable audit trail entry
 *   }
 *
 * Rejection cases (allowed: false):
 *   • requestPayload is null, undefined, or not a plain object
 *   • requestPayload.purpose is missing, null, or not a string
 *   • requestPayload.purpose is not in APPROVED_PURPOSES
 *
 * @param  {object} requestPayload  Inbound consent request body
 * @returns {{ allowed: boolean, purpose: string|null, reason: string }}
 */
function processConsentRequest(requestPayload) {
  // ── Payload guard ─────────────────────────────────────────────────────────
  if (
    requestPayload === null ||
    requestPayload === undefined ||
    typeof requestPayload !== "object" ||
    Array.isArray(requestPayload)
  ) {
    return _blocked(null, "invalid request payload: expected a plain object");
  }

  const { purpose } = requestPayload;

  // ── Purpose field guard ───────────────────────────────────────────────────
  if (purpose === null || purpose === undefined) {
    return _blocked(null, "missing required field: purpose");
  }

  if (typeof purpose !== "string" || purpose.trim() === "") {
    return _blocked(purpose, "invalid purpose field: must be a non-empty string");
  }

  // ── Trust-boundary validation via isPurposeValid ──────────────────────────
  // This is the canonical attach-point: the standalone validator is called
  // with the live APPROVED_PURPOSES registry on every inbound request.
  if (!isPurposeValid(purpose, APPROVED_PURPOSES)) {
    return _blocked(purpose, `purpose "${purpose}" is not in the approved tier list`);
  }

  return _allowed(purpose);
}

module.exports = { processConsentRequest, APPROVED_PURPOSES };

// ── E2E proof block ───────────────────────────────────────────────────────────
// Executed only when this file is run directly:
//   node src/utils/consent/purposeGateway.js
// Proves that processConsentRequest() correctly calls isPurposeValid() at the
// trust boundary for every significant input class.

/* istanbul ignore next */
if (require.main === module) {
  const assert = require("assert");

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

  // ── E2E Suite 1: Approved purposes → allowed: true ─────────────────────────

  console.log("\n[E2E Suite 1] Approved purposes — gateway returns allowed: true");

  for (const purpose of APPROVED_PURPOSES) {
    runTest(
      `{ purpose: "${purpose}" } → allowed: true`,
      () => {
        const result = processConsentRequest({ purpose });
        assert.strictEqual(result.allowed, true,
          `Expected allowed for approved purpose "${purpose}"`);
        assert.strictEqual(result.purpose, purpose);
        assert.strictEqual(result.reason, "purpose approved");
      }
    );
  }

  // ── E2E Suite 2: Unapproved purposes → allowed: false ──────────────────────

  console.log("\n[E2E Suite 2] Unapproved purposes — gateway returns allowed: false");

  const unapproved = [
    "tracking",
    "profiling",
    "data-sale",
    "ANALYTICS",          // wrong case — not in registry
    "analytics ",         // trailing space — not in registry
    " essential",         // leading space — not in registry
    "",                   // empty string
  ];

  for (const purpose of unapproved) {
    runTest(
      `{ purpose: ${JSON.stringify(purpose)} } → allowed: false`,
      () => {
        const result = processConsentRequest({ purpose });
        assert.strictEqual(result.allowed, false,
          `Expected blocked for unapproved purpose ${JSON.stringify(purpose)}`);
      }
    );
  }

  // ── E2E Suite 3: Invalid request payloads → allowed: false ─────────────────

  console.log("\n[E2E Suite 3] Invalid payloads — gateway returns allowed: false");

  const invalidPayloads = [
    [null,              "null payload"],
    [undefined,         "undefined payload"],
    ["analytics",       "string instead of object"],
    [42,                "number instead of object"],
    [true,              "boolean instead of object"],
    [["analytics"],     "array instead of object"],
    [{},                "empty object — missing purpose field"],
    [{ purpose: null }, "purpose explicitly null"],
    [{ purpose: 123 },  "purpose is a number"],
    [{ purpose: true }, "purpose is a boolean"],
  ];

  for (const [payload, label] of invalidPayloads) {
    runTest(
      `${label} → allowed: false`,
      () => {
        const result = processConsentRequest(payload);
        assert.strictEqual(result.allowed, false,
          `Expected blocked for: ${label}`);
        assert.strictEqual(typeof result.reason, "string",
          "reason must always be a string");
        assert.ok(result.reason.length > 0,
          "reason must be non-empty");
      }
    );
  }

  // ── E2E Suite 4: Validator integration — isPurposeValid call-through proof ─

  console.log("\n[E2E Suite 4] Validator integration — isPurposeValid fires at trust boundary");

  runTest(
    "isPurposeValid(purpose, APPROVED_PURPOSES) returns true for 'analytics' directly",
    () => assert.strictEqual(isPurposeValid("analytics", APPROVED_PURPOSES), true)
  );

  runTest(
    "isPurposeValid(purpose, APPROVED_PURPOSES) returns false for 'tracking' directly",
    () => assert.strictEqual(isPurposeValid("tracking", APPROVED_PURPOSES), false)
  );

  runTest(
    "gateway result for 'analytics' agrees with direct isPurposeValid call",
    () => {
      const gatewayResult = processConsentRequest({ purpose: "analytics" });
      const validatorResult = isPurposeValid("analytics", APPROVED_PURPOSES);
      assert.strictEqual(gatewayResult.allowed, validatorResult,
        "gateway allowed must equal isPurposeValid result — attach-point wiring verified");
    }
  );

  runTest(
    "gateway result for 'tracking' agrees with direct isPurposeValid call",
    () => {
      const gatewayResult = processConsentRequest({ purpose: "tracking" });
      const validatorResult = isPurposeValid("tracking", APPROVED_PURPOSES);
      assert.strictEqual(gatewayResult.allowed, validatorResult,
        "gateway allowed must equal isPurposeValid result — attach-point wiring verified");
    }
  );

  // ── E2E Suite 5: Decision object structure guarantees ──────────────────────

  console.log("\n[E2E Suite 5] Decision object structure — all fields always present");

  runTest(
    "allowed result has shape { allowed, purpose, reason }",
    () => {
      const r = processConsentRequest({ purpose: "essential" });
      assert.ok("allowed"  in r, "missing field: allowed");
      assert.ok("purpose"  in r, "missing field: purpose");
      assert.ok("reason"   in r, "missing field: reason");
      assert.strictEqual(typeof r.allowed, "boolean");
      assert.strictEqual(typeof r.reason,  "string");
    }
  );

  runTest(
    "blocked result has shape { allowed, purpose, reason }",
    () => {
      const r = processConsentRequest({ purpose: "profiling" });
      assert.ok("allowed"  in r, "missing field: allowed");
      assert.ok("purpose"  in r, "missing field: purpose");
      assert.ok("reason"   in r, "missing field: reason");
      assert.strictEqual(typeof r.allowed, "boolean");
      assert.strictEqual(typeof r.reason,  "string");
    }
  );

  runTest(
    "invalid-payload result has shape { allowed: false, purpose: null, reason: string }",
    () => {
      const r = processConsentRequest(null);
      assert.strictEqual(r.allowed,         false);
      assert.strictEqual(r.purpose,         null);
      assert.strictEqual(typeof r.reason,   "string");
      assert.ok(r.reason.length > 0);
    }
  );

  runTest(
    "allowed is always a strict boolean — never truthy/falsy",
    () => {
      const r1 = processConsentRequest({ purpose: "marketing" });
      const r2 = processConsentRequest({ purpose: "spam" });
      assert.strictEqual(typeof r1.allowed, "boolean");
      assert.strictEqual(typeof r2.allowed, "boolean");
    }
  );

  // ── Final result ────────────────────────────────────────────────────────────

  const divider = "─".repeat(62);
  console.log(`\n${divider}`);

  if (totalFailed === 0) {
    console.log(
      `[PASS] All ${totalPassed} assertions passed.` +
      ` Purpose gateway E2E contract fully verified.`
    );
    process.exit(0);
  } else {
    console.error(
      `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
    );
    process.exit(1);
  }
}
