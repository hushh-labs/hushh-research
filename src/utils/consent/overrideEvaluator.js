"use strict";

/**
 * resolveConsentState(globalStatus, localOverride)
 *
 * Resolves the effective consent state from a two-tier cascade:
 *
 *   Tier 1 — Local override (highest authority)
 *     When `localOverride` is an explicit boolean (`true` or `false`), it is
 *     returned immediately and unconditionally.  A local `false` override
 *     MUST be able to revoke a global `true` consent — this is the primary
 *     security invariant of the cascade.
 *
 *   Tier 2 — Global status (fallback)
 *     When `localOverride` is absent, `null`, or `undefined`, the function
 *     falls back to `globalStatus`.  If `globalStatus` is an explicit boolean
 *     it is returned directly.
 *
 *   Tier 3 — Default-deny (safety net)
 *     When both parameters are absent, non-boolean, or otherwise unresolvable,
 *     `false` is returned — ensuring that ambiguous state never silently grants
 *     access.
 *
 * Type strictness:
 *   Only values that are strictly `=== true` or `=== false` (primitive booleans)
 *   are treated as meaningful consent signals.  Strings like `"true"`, numbers
 *   like `1`, and any other truthy/falsy values are treated as absent and fall
 *   through to the next tier.  This prevents implicit type coercion from
 *   creating phantom consent grants.
 *
 * @param  {boolean|*} globalStatus   Broad/system-level consent flag
 * @param  {boolean|*} localOverride  Per-entity override; absent = not set
 * @returns {boolean}  Resolved consent state — always a strict boolean
 */
function resolveConsentState(globalStatus, localOverride) {
  // ── Tier 1: explicit local override — highest authority ──────────────────
  // typeof check ensures only primitive true/false qualify; no coercion.
  if (typeof localOverride === "boolean") {
    return localOverride;
  }

  // ── Tier 2: no local override — fall back to global status ───────────────
  if (typeof globalStatus === "boolean") {
    return globalStatus;
  }

  // ── Tier 3: both unresolvable — default-deny ─────────────────────────────
  return false;
}

module.exports = { resolveConsentState };
