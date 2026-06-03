"use strict";

/**
 * The exact string tokens that are treated as an affirmative consent signal.
 * Comparison is performed case-insensitively on a trimmed copy of the input.
 *
 * Anything not in this set — including "false", "no", "off", "0", empty
 * strings, and all non-string / non-numeric types — resolves to false under
 * the secure-default posture.
 */
const TRUTHY_STRING_TOKENS = new Set(["true", "on", "yes", "1"]);

/**
 * normalizeConsentBool(value)
 *
 * Coerces fuzzy or loosely-typed incoming consent-metadata values into a
 * strict native JavaScript boolean, applying a secure-default posture:
 *
 *   → true   :  true (boolean), 1 (number),
 *               "true" | "on" | "yes" | "1"  (case-insensitive, trimmed)
 *
 *   → false  :  everything else — including false, 0, null, undefined,
 *               empty string, "false", "no", "off", "0", objects, arrays
 *
 * The output is always a native boolean (typeof result === "boolean"),
 * never a truthy/falsy non-boolean.  No exceptions are thrown.
 *
 * @param  {*} value
 * @returns {boolean}
 */
function normalizeConsentBool(value) {
  // Native boolean — fast-path
  if (value === true)  return true;
  if (value === false) return false;

  // Numeric flag — only the integer 1 is affirmative
  if (value === 1) return true;
  if (value === 0) return false;

  // String token — trim and lower-case before Set lookup
  if (typeof value === "string") {
    return TRUTHY_STRING_TOKENS.has(value.trim().toLowerCase());
  }

  // Everything else: null, undefined, objects, arrays, NaN, … → false
  return false;
}

module.exports = { normalizeConsentBool };
