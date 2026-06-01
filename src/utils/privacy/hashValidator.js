"use strict";

/**
 * isValidHexHash(hashString, expectedLength = 64)
 *
 * Structurally validates that an incoming anonymised user identifier, token,
 * or encryption signature is a properly formatted hexadecimal string of the
 * required length.
 *
 * Validation rules:
 *   - `hashString` must be a string (not null, array, number, …)
 *   - `expectedLength` must be a positive integer (default: 64 for SHA-256)
 *   - The string must contain exclusively hex characters: [0-9a-fA-F]
 *   - The string length must be exactly `expectedLength`
 *   - Both upper-case (A-F) and lower-case (a-f) hex digits are accepted
 *
 * Returns:
 *   true  — string is a valid hex hash of the expected length
 *   false — any structural violation, wrong length, non-hex symbol, or
 *            invalid / non-string input; never throws
 *
 * @param  {string} hashString             — hash to validate
 * @param  {number} [expectedLength = 64]  — required exact character count
 * @returns {boolean}
 */
function isValidHexHash(hashString, expectedLength = 64) {
  // ── Type guard: hashString ────────────────────────────────────────────────
  if (typeof hashString !== "string") {
    return false;
  }

  // ── Boundary guard: expectedLength ────────────────────────────────────────
  // Must be a finite, positive integer — floats and negatives are rejected.
  if (
    typeof expectedLength !== "number"  ||
    !Number.isFinite(expectedLength)    ||
    !Number.isInteger(expectedLength)   ||
    expectedLength <= 0
  ) {
    return false;
  }

  // ── Structural validation ─────────────────────────────────────────────────
  // The regex anchors both ends (^ and $) and requires EXACTLY expectedLength
  // characters drawn from the hex alphabet [0-9a-fA-F].
  return new RegExp(`^[0-9a-fA-F]{${expectedLength}}$`).test(hashString);
}

module.exports = { isValidHexHash };
