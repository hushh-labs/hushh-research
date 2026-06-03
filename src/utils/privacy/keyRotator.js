"use strict";

/**
 * Milliseconds per hour — used to convert maxAgeInHours to ms for comparison.
 */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * needsKeyRotation(lastRotatedIso, maxAgeInHours)
 *
 * Determines whether a cryptographic key has exceeded its operational
 * lifespan and must be rotated.
 *
 * Decision rule:
 *   elapsed = Date.now() − Date.parse(lastRotatedIso)
 *   needs rotation  ←→  elapsed >= maxAgeInHours × 3 600 000 ms
 *
 * Strict security posture — returns TRUE (force rotation) for all of:
 *   • lastRotatedIso is null / undefined / non-string / empty
 *   • lastRotatedIso is a malformed or semantically invalid ISO string
 *   • maxAgeInHours is null / undefined / non-number / NaN / ±Infinity
 *   • maxAgeInHours is negative
 *   • maxAgeInHours is zero  (zero-length window means always rotate)
 *
 * Returns FALSE (key is still valid) when:
 *   • elapsed time is strictly less than maxAgeInHours
 *   • lastRotatedIso is in the future (clock-skew tolerance)
 *
 * @param  {string} lastRotatedIso   — ISO 8601 date-time of last rotation event
 * @param  {number} maxAgeInHours    — maximum permitted key age in hours
 * @returns {boolean}  true = rotate now; false = still valid
 */
function needsKeyRotation(lastRotatedIso, maxAgeInHours) {
  // ── Validate maxAgeInHours ────────────────────────────────────────────────
  if (
    typeof maxAgeInHours !== "number" ||
    !Number.isFinite(maxAgeInHours) ||
    maxAgeInHours <= 0
  ) {
    return true; // invalid or non-positive limit → force rotation
  }

  // ── Validate lastRotatedIso ───────────────────────────────────────────────
  if (
    typeof lastRotatedIso !== "string" ||
    lastRotatedIso.trim() === ""
  ) {
    return true; // missing or non-string → force rotation
  }

  const lastRotatedMs = Date.parse(lastRotatedIso);
  if (isNaN(lastRotatedMs)) {
    return true; // malformed / semantically invalid date → force rotation
  }

  // ── Evaluate elapsed time ─────────────────────────────────────────────────
  const elapsedMs = Date.now() - lastRotatedMs;

  if (elapsedMs < 0) {
    // lastRotatedIso is in the future (clock-skew / test scenario) → valid
    return false;
  }

  return elapsedMs >= maxAgeInHours * MS_PER_HOUR;
}

module.exports = { needsKeyRotation };
