"use strict";

/**
 * Threshold to distinguish millisecond timestamps from second timestamps.
 *
 * consent-protocol/hushh_mcp/consent/token.py issues tokens with:
 *   issued_at  = int(time.time() * 1000)       ← milliseconds
 *   expires_at = issued_at + expires_in_ms      ← milliseconds
 *
 * The JS session-token and vault-owner-token routes receive this as
 * data.expiresAt (ms).  Values >= 1e10 are already in ms; smaller values
 * are treated as seconds and multiplied by 1 000.
 */
const MS_THRESHOLD = 1e10;

/**
 * Normalises a raw expiresAt value to a milliseconds integer.
 * Returns NaN for any input that cannot be resolved to a finite positive number.
 */
function normaliseExpiresAt(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return NaN;
  }
  return raw >= MS_THRESHOLD ? raw : raw * 1000;
}

/**
 * isConsentTokenExpired(expiresAt)
 *
 * Determines whether a Hushh consent token has expired by comparing its
 * expiresAt timestamp against the current wall-clock time.
 *
 * Mirrors the expiry gate inside
 * consent-protocol/hushh_mcp/consent/token.py → validate_token():
 *
 *   if int(time.time() * 1000) >= int(expires_at_str):
 *       return False, "Token expired", None
 *
 * The JS equivalent is:  Date.now() >= expiresAt
 *
 * Accepts ms or seconds timestamps (auto-detected via 1e10 threshold).
 * Invalid / malformed inputs return true (expired) — max-security posture.
 *
 * @param  {number} expiresAt — Unix timestamp of the token's expiry (ms or s)
 * @returns {boolean}  true = expired or invalid, false = still valid
 */
function isConsentTokenExpired(expiresAt) {
  const expiresAtMs = normaliseExpiresAt(expiresAt);
  if (isNaN(expiresAtMs)) return true;
  return Date.now() >= expiresAtMs;
}

/**
 * parseTokenExpiry(tokenResponse)
 *
 * Extracts and evaluates the expiry field from a consent token API response,
 * covering both shapes produced by the Hushh consent-token endpoints:
 *
 *   camelCase  { expiresAt: number }   — JS routes:
 *                /api/consent/session-token  (session-token/route.ts)
 *                /api/consent/vault-owner-token  (vault-owner-token/route.ts)
 *   snake_case { expires_at: number }  — Python backend direct response
 *                hushh_mcp/consent/token.py → HushhConsentToken.expires_at
 *
 * camelCase takes precedence when both keys are present.
 *
 * Returns { expiresAt: number|null, isExpired: boolean }.
 * Malformed, null, or non-object inputs return
 * { expiresAt: null, isExpired: true } — max-security fallback, never throws.
 *
 * @param  {object|*} tokenResponse — response from a token-issuance endpoint
 * @returns {{ expiresAt: number|null, isExpired: boolean }}
 */
function parseTokenExpiry(tokenResponse) {
  if (
    tokenResponse === null ||
    typeof tokenResponse !== "object" ||
    Array.isArray(tokenResponse)
  ) {
    return { expiresAt: null, isExpired: true };
  }

  // Prefer camelCase (JS routes); fall back to snake_case (Python direct)
  const raw =
    tokenResponse.expiresAt !== undefined
      ? tokenResponse.expiresAt
      : tokenResponse.expires_at;

  const expiresAtMs = normaliseExpiresAt(raw);
  if (isNaN(expiresAtMs)) {
    return { expiresAt: null, isExpired: true };
  }

  return { expiresAt: expiresAtMs, isExpired: Date.now() >= expiresAtMs };
}

module.exports = { isConsentTokenExpired, parseTokenExpiry };
