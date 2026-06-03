"use strict";

/**
 * Milliseconds in one calendar day — used to convert windowInDays to ms.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * isWithinComplianceWindow(startDateIso, windowInDays)
 *
 * Evaluates whether the current wall-clock time still falls within the
 * compliance tracking window that opened at startDateIso.
 *
 * The window is considered open while:
 *
 *   Date.now() <= new Date(startDateIso) + windowInDays * 86 400 000 ms
 *
 * Security posture — DEFAULT DENY:
 *   Any input that cannot be validated unambiguously returns false so that
 *   no expired or corrupted consent record is accidentally treated as active.
 *
 * Validation rules:
 *   startDateIso  — must be a non-empty string that parses to a valid Date.
 *   windowInDays  — must be a finite, positive number (integers and
 *                   fractional days are both accepted).
 *
 * Returns false for all of the following (in addition to an expired window):
 *   - startDateIso is null / undefined / not a string / empty
 *   - startDateIso parses to NaN  (e.g. "not-a-date", "2099-99-99")
 *   - windowInDays is null / undefined / not a number / NaN / ±Infinity
 *   - windowInDays is zero or negative
 *
 * @param  {string} startDateIso   — ISO 8601 date-time string
 * @param  {number} windowInDays   — compliance window length in calendar days
 * @returns {boolean}              — true = still within window; false = expired/invalid
 */
function isWithinComplianceWindow(startDateIso, windowInDays) {
  // ── Validate startDateIso ─────────────────────────────────────────────────
  if (typeof startDateIso !== "string" || startDateIso.trim() === "") {
    return false;
  }

  const startMs = Date.parse(startDateIso);
  if (isNaN(startMs)) {
    return false; // malformed or semantically invalid date string
  }

  // ── Validate windowInDays ────────────────────────────────────────────────
  if (
    typeof windowInDays !== "number" ||
    !Number.isFinite(windowInDays) ||
    windowInDays <= 0
  ) {
    return false;
  }

  // ── Evaluate the window ───────────────────────────────────────────────────
  const expiryMs = startMs + windowInDays * MS_PER_DAY;
  return Date.now() <= expiryMs;
}

module.exports = { isWithinComplianceWindow };
