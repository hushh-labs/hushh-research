"use strict";

/**
 * The three privacy-preference switches this utility manages.
 * Any key in this set that is absent or non-boolean in the incoming
 * profile is populated with `false` (maximum-restriction posture).
 */
const PRIVACY_KEYS = ["functional", "analytics", "marketing"];

/**
 * Returns true only for plain (non-null, non-array) objects.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * applyPrivacyFallbacks(userProfile)
 *
 * Evaluates an incoming user profile record or session state and returns a
 * new, sanitised profile object with a complete privacy-preference block.
 *
 * Fallback rules:
 *   - Each of `functional`, `analytics`, and `marketing` is inspected.
 *   - If the key is present AND its value is an explicit boolean, it is
 *     carried through to the output unchanged.
 *   - If the key is missing, null, or holds a non-boolean value (string,
 *     number, object …), it is set to `false` in the output.
 *     This enforces the maximum-security / data-restriction posture: when
 *     consent cannot be unambiguously confirmed it is treated as denied.
 *
 * Immutability guarantee:
 *   The original `userProfile` reference is never modified.  The returned
 *   object is always a freshly allocated shallow copy.
 *
 * Safe-fallback rules (returns the full-false default without throwing):
 *   - null / undefined / non-object input
 *   - empty object {}
 *   - any input whose privacy switches are partially or fully absent
 *
 * @param  {object|*} userProfile — incoming profile or session state
 * @returns {{ functional: boolean, analytics: boolean, marketing: boolean, ...rest }}
 */
function applyPrivacyFallbacks(userProfile) {
  // ── Normalise input ───────────────────────────────────────────────────────
  // Non-plain-object inputs (null, undefined, string, number, array …) are
  // treated as an empty profile so the fallback block is fully populated.
  const base = isPlainObject(userProfile) ? { ...userProfile } : {};

  // ── Apply maximum-privacy fallbacks ───────────────────────────────────────
  for (const key of PRIVACY_KEYS) {
    if (typeof base[key] !== "boolean") {
      base[key] = false;
    }
  }

  return base;
}

module.exports = { applyPrivacyFallbacks };
