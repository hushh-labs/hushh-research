"use strict";

/**
 * src/utils/index.js
 *
 * Central canonical export registry for the @hushh/utils surface.
 *
 * Aggregates the consent-validation and privacy-masking utilities into a
 * single importable entry point so that callers (hushh-webapp API routes,
 * consent-protocol service helpers) can resolve both modules from one
 * well-known path instead of reaching into sub-directories directly.
 *
 * Exported API:
 *
 *   validateConsentPayload(payload)
 *     Validates a consent action payload before it is forwarded to the
 *     Python consent-protocol backend.
 *     Wired to: api-service.ts approvePendingConsent / denyPendingConsent
 *               → POST /api/consent/pending/approve|deny
 *     Returns: { valid: true, sanitized } | { valid: false, error }
 *
 *   maskUserIdentifier(input)
 *     Returns a consent-minimised (masked) representation of an email
 *     address or phone number.
 *     Wired to: same data-minimisation contract as maskPhoneNumber in
 *               hushh-webapp/lib/services/phone-mandate-service.ts
 *     Returns: masked string | "" on invalid input (never throws)
 */

const { validateConsentPayload } = require("./consent/payloadValidator");
const { maskUserIdentifier }     = require("./privacy/stringMasker");

module.exports = {
  validateConsentPayload,
  maskUserIdentifier,
};
