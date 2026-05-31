"use strict";

/**
 * Appended to every truncated token so consumers can detect and audit
 * that the original value was clipped.  Counted against the maxLength
 * ceiling — the final output is always exactly maxLength characters.
 */
const TRUNCATION_SUFFIX = "...[TRUNCATED]"; // 14 characters

/**
 * truncateDataToken(tokenString, maxLength = 512)
 *
 * Enforces a strict uniform length ceiling on incoming user tracking
 * token bundles or data payloads to prevent buffer over-read issues and
 * uphold the data-minimisation protocol.
 *
 * Behaviour table:
 *
 *   tokenString.length <= maxLength
 *     → token returned unmodified
 *
 *   tokenString.length >  maxLength  AND  maxLength >= SUFFIX length (14)
 *     → token.slice(0, maxLength - 14) + "...[TRUNCATED]"
 *       (final string is exactly maxLength characters)
 *
 *   tokenString.length >  maxLength  AND  maxLength < SUFFIX length (14)
 *     → token.slice(0, maxLength)
 *       (ceiling too tight for suffix — hard truncation, no suffix)
 *
 *   non-string tokenString            → ""  (safe fallback, never throws)
 *   maxLength <= 0 / non-finite / NaN → ""  (invalid boundary, never throws)
 *
 * @param  {string} tokenString        — incoming token or payload string
 * @param  {number} [maxLength=512]    — maximum permitted output length
 * @returns {string}
 */
function truncateDataToken(tokenString, maxLength = 512) {
  // ── Type guard — tokenString ───────────────────────────────────────────────
  if (typeof tokenString !== "string") {
    return "";
  }

  // ── Boundary guard — maxLength ─────────────────────────────────────────────
  if (
    typeof maxLength !== "number" ||
    !Number.isFinite(maxLength) ||
    maxLength <= 0
  ) {
    return "";
  }

  const limit = Math.floor(maxLength); // normalise floats (e.g. 50.9 → 50)

  // ── Token is within the ceiling — return as-is ────────────────────────────
  if (tokenString.length <= limit) {
    return tokenString;
  }

  // ── Token exceeds the ceiling — truncate with suffix ──────────────────────
  if (limit >= TRUNCATION_SUFFIX.length) {
    // Slice leaves exactly (limit - 14) chars for the payload body, then
    // appends the 14-char suffix so total === limit.
    return tokenString.slice(0, limit - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  }

  // ── Ceiling too tight to fit even the suffix — hard truncate ──────────────
  return tokenString.slice(0, limit);
}

module.exports = { truncateDataToken };
