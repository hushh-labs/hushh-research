"use strict";

/**
 * The three consent layers this evaluator recognises and emits.
 * Any key outside this set is silently dropped from the output.
 */
const KNOWN_FLAGS = ["functional", "analytics", "marketing"];

/**
 * Returns true only for plain (non-null, non-array) objects.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves a single consent flag to an explicit boolean using a two-layer
 * priority chain:
 *
 *   1. userValue   — if it is a boolean, use it directly
 *                  — if it is "true" / "false" (case-insensitive), coerce it
 *                  — any other string / non-boolean type → treated as absent
 *   2. defaultValue — same coercion rules applied to the fallback layer
 *   3. false        — the hard-coded safe fallback when both layers are absent
 *                     or unresolvable (privacy-by-default: restrict everything)
 */
function resolveFlag(userValue, defaultValue) {
  // ── Layer 1: user value ────────────────────────────────────────────────────
  if (typeof userValue === "boolean") {
    return userValue;
  }
  if (typeof userValue === "string") {
    const norm = userValue.trim().toLowerCase();
    if (norm === "true") return true;
    if (norm === "false") return false;
    // Unrecognised string (e.g. "maybe", "yes") → fall through to default
  }

  // ── Layer 2: global default ────────────────────────────────────────────────
  if (typeof defaultValue === "boolean") {
    return defaultValue;
  }
  if (typeof defaultValue === "string") {
    const norm = defaultValue.trim().toLowerCase();
    if (norm === "true") return true;
    if (norm === "false") return false;
  }

  // ── Layer 3: hard safe fallback ────────────────────────────────────────────
  return false;
}

/**
 * evaluateCookieFlags(userFlags, globalDefaults)
 *
 * Evaluates multi-layer privacy permission settings and returns a clean, flat
 * object containing explicit booleans for the three consent layers.
 *
 * Merge priority (highest → lowest):
 *   userFlags  →  globalDefaults  →  false  (privacy-by-default)
 *
 * Rules:
 *   - Only `functional`, `analytics`, and `marketing` are emitted; unknown
 *     keys from either input are silently discarded.
 *   - String values "true" / "false" (case-insensitive) are safely coerced.
 *   - Any other non-boolean type (number, object, unrecognised string) is
 *     treated as absent and the next layer is consulted.
 *   - null, undefined, or non-object inputs for either parameter are treated
 *     as empty objects; the function never throws.
 *
 * @param  {object|*} userFlags      — per-user consent preference object
 * @param  {object|*} globalDefaults — site-wide fallback consent configuration
 * @returns {{ functional: boolean, analytics: boolean, marketing: boolean }}
 */
function evaluateCookieFlags(userFlags, globalDefaults) {
  const safeUser = isPlainObject(userFlags) ? userFlags : {};
  const safeDefaults = isPlainObject(globalDefaults) ? globalDefaults : {};

  const result = {};
  for (const key of KNOWN_FLAGS) {
    result[key] = resolveFlag(safeUser[key], safeDefaults[key]);
  }
  return result;
}

module.exports = { evaluateCookieFlags };
