"use strict";

const MS_PER_DAY = 86_400_000; // 24 * 60 * 60 * 1_000

/**
 * Threshold that separates millisecond timestamps from second timestamps.
 *
 * Current Unix time in seconds ≈ 1.75 × 10⁹  (<  1 × 10¹⁰)  → seconds
 * Current Unix time in ms      ≈ 1.75 × 10¹²  (>= 1 × 10¹⁰)  → milliseconds
 *
 * Values below 1e10 span seconds-timestamps up to the year 2286.
 * Values at or above 1e10 cover ms-timestamps from April 23 1970 onward —
 * all realistic consent records fall clearly on one side of this line.
 */
const MS_THRESHOLD = 1e10;

/**
 * Normalises a raw timestamp value to a milliseconds integer.
 *
 * Accepts a positive finite number (ms or seconds) or a numeric string.
 * Returns NaN for anything unresolvable — null, undefined, boolean,
 * object, empty / non-numeric string, NaN, Infinity, or negative values.
 *
 * @param  {*} raw
 * @returns {number}  milliseconds integer, or NaN on failure
 */
function toMilliseconds(raw) {
  let n;

  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    n = Number(raw);
  } else {
    return NaN;
  }

  if (!Number.isFinite(n) || n < 0) {
    return NaN;
  }

  // Values below the threshold are seconds → convert to ms
  return n >= MS_THRESHOLD ? n : n * 1000;
}

/**
 * isConsentExpired(timestamp, ttlInDays = 365)
 *
 * Evaluates whether a user's privacy preference signature has passed its
 * Time-To-Live (TTL) window.
 *
 * Security posture — maximum-security fallback:
 *   Any ambiguous, malformed, or unresolvable input returns `true` (expired)
 *   so that corrupted consent records can never silently grant permissions.
 *
 * Expiry rule:
 *   currentTime − consentTime > ttlInDays  →  true  (expired)
 *   currentTime − consentTime ≤ ttlInDays  →  false (still valid)
 *   consentTime in the future               →  false (clock-drift tolerance)
 *
 * @param  {number|string} timestamp  — Unix timestamp in ms or seconds
 * @param  {number}        ttlInDays  — consent lifetime in days (default 365)
 * @returns {boolean}  true = expired or invalid, false = still valid
 */
function isConsentExpired(timestamp, ttlInDays = 365) {
  // ── Validate TTL ──────────────────────────────────────────────────────────
  if (
    typeof ttlInDays !== "number" ||
    !Number.isFinite(ttlInDays)   ||
    ttlInDays <= 0
  ) {
    return true; // invalid TTL → max-security: treat consent as expired
  }

  // ── Normalise timestamp → milliseconds ────────────────────────────────────
  const tsMs = toMilliseconds(timestamp);
  if (isNaN(tsMs)) {
    return true; // unresolvable timestamp → max-security fallback
  }

  // ── Compute age and compare against TTL ───────────────────────────────────
  const diffMs = Date.now() - tsMs;

  if (diffMs < 0) {
    return false; // future timestamp — not expired (clock-drift tolerance)
  }

  return diffMs > ttlInDays * MS_PER_DAY;
}

module.exports = { isConsentExpired };
