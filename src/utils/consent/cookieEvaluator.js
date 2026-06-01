"use strict";

/**
 * Canonical set of consent-flag keys written to the vault under the
 * "cookie_flags" preference field via:
 *
 *   hushh-webapp/lib/services/api-service.ts → storePreferences()
 *   hushh-webapp/app/api/vault/store-preferences/route.ts
 *
 * Values resolved by evaluateCookieFlags() are encrypted by the caller
 * and stored as  { ciphertext, iv, tag }  in the user's private vault.
 * Frozen to prevent runtime mutation of the canonical field list.
 */
const KNOWN_FLAGS = Object.freeze(["functional", "analytics", "marketing"]);

/**
 * Privacy-by-default safe values for every known flag.
 * These defaults are applied by resolveConsentFlags() when the user has
 * not made an explicit boolean choice for a given category.
 *
 * Frozen and exported so callers can inspect the canonical defaults
 * without re-deriving them.
 */
const COOKIE_CONSENT_DEFAULTS = Object.freeze({
  functional: false,
  analytics:  false,
  marketing:  false,
});

// ── Internal helpers ───────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves a single consent flag to an explicit boolean using a two-layer
 * priority chain:
 *   1. userValue   — boolean, or "true"/"false" string (case-insensitive, trimmed)
 *   2. defaultValue — same coercion rules applied to the fallback layer
 *   3. false        — hard-coded privacy-by-default safe fallback
 */
function resolveFlag(userValue, defaultValue) {
  if (typeof userValue === "boolean") return userValue;
  if (typeof userValue === "string") {
    const norm = userValue.trim().toLowerCase();
    if (norm === "true")  return true;
    if (norm === "false") return false;
  }

  if (typeof defaultValue === "boolean") return defaultValue;
  if (typeof defaultValue === "string") {
    const norm = defaultValue.trim().toLowerCase();
    if (norm === "true")  return true;
    if (norm === "false") return false;
  }

  return false;
}

// ── Pure utility ───────────────────────────────────────────────────────────────

/**
 * evaluateCookieFlags(userFlags, globalDefaults)
 *
 * Evaluates multi-layer consent-flag settings and returns a clean flat
 * object with explicit booleans for the three known consent layers only.
 * Unknown keys from either input are silently discarded.
 *
 * Merge priority:  userFlags → globalDefaults → false (privacy-by-default)
 *
 * Accepts boolean or "true"/"false" string values in either layer.
 * null / undefined / non-plain-object inputs are normalised to {}.
 * Never throws.
 *
 * @param  {object|*} userFlags      — per-user preference object
 * @param  {object|*} globalDefaults — site-wide fallback configuration
 * @returns {{ functional: boolean, analytics: boolean, marketing: boolean }}
 */
function evaluateCookieFlags(userFlags, globalDefaults) {
  const safeUser     = isPlainObject(userFlags)     ? userFlags     : {};
  const safeDefaults = isPlainObject(globalDefaults) ? globalDefaults : {};

  const result = {};
  for (const key of KNOWN_FLAGS) {
    result[key] = resolveFlag(safeUser[key], safeDefaults[key]);
  }
  return result;
}

// ── Wired vault-storage boundary ──────────────────────────────────────────────

/**
 * resolveConsentFlags(userFlags)
 *
 * Wired variant — resolves partial or malformed user consent-flag input
 * against the canonical COOKIE_CONSENT_DEFAULTS (all false, privacy-by-default)
 * to produce the complete boolean record that is then encrypted and persisted
 * to the user's private vault:
 *
 *   resolveConsentFlags(userInput)
 *     → { functional: boolean, analytics: boolean, marketing: boolean }
 *     → encrypt(result)
 *     → storePreferences({
 *         userId,
 *         preferences: { cookie_flags: { ciphertext, iv, tag } },
 *         consentToken,
 *       })
 *
 * This function MUST be called before encrypting and forwarding consent
 * flags to  POST /api/vault/store-preferences  (store-preferences/route.ts).
 *
 * @param  {object|*} userFlags — raw consent flag input from the UI layer
 * @returns {{ functional: boolean, analytics: boolean, marketing: boolean }}
 */
function resolveConsentFlags(userFlags) {
  return evaluateCookieFlags(userFlags, COOKIE_CONSENT_DEFAULTS);
}

module.exports = {
  resolveConsentFlags,      // wired public API — use before vault storage
  evaluateCookieFlags,      // pure utility — use with a caller-supplied fallback
  COOKIE_CONSENT_DEFAULTS,  // exported for inspection and test assertions
  KNOWN_FLAGS,              // exported for field enumeration
};
