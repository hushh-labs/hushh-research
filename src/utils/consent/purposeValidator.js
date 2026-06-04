"use strict";

/**
 * isPurposeValid(requestedPurpose, allowedPurposesArray)
 *
 * Determines whether an incoming consent purpose is explicitly listed in the
 * caller-supplied allowlist.  Designed as a pure, stateless predicate so it
 * can be embedded at any request boundary without side-effects.
 *
 * Default-deny posture:
 *   Every input that is missing, non-string, non-array, empty, or whose
 *   purpose is not present in the allowlist returns `false`.  Only an
 *   exact-match hit returns `true` — no partial matching, no coercion,
 *   no case-normalisation.
 *
 * Validation rules:
 *   requestedPurpose      — must be a non-empty string; null, undefined,
 *                           whitespace-only, and non-string values → false
 *   allowedPurposesArray  — must be a non-empty array; null, undefined,
 *                           non-array, and empty-array values → false
 *
 * Lookup is performed with Array.prototype.includes(), which uses the
 * SameValueZero algorithm — equivalent to strict equality (===) for
 * strings.  "ANALYTICS" does not match "analytics".
 *
 * @param  {string}   requestedPurpose      The purpose string from the request
 * @param  {string[]} allowedPurposesArray  Canonical list of permitted purposes
 * @returns {boolean} `true` if found; `false` in all other cases
 */
function isPurposeValid(requestedPurpose, allowedPurposesArray) {
  // ── Guard: requestedPurpose must be a non-empty string ─────────────────────
  if (
    requestedPurpose === null ||
    requestedPurpose === undefined ||
    typeof requestedPurpose !== "string" ||
    requestedPurpose.trim() === ""
  ) {
    return false;
  }

  // ── Guard: allowedPurposesArray must be a non-empty array ──────────────────
  if (
    !Array.isArray(allowedPurposesArray) ||
    allowedPurposesArray.length === 0
  ) {
    return false;
  }

  // ── Membership check: exact string match only ───────────────────────────────
  return allowedPurposesArray.includes(requestedPurpose);
}

module.exports = { isPurposeValid };
