"use strict";

/**
 * Canvas methods that extract device-specific rendered output and are
 * canonically associated with fingerprinting attacks:
 *
 *   toDataURL   — serialises the entire canvas bitmap to a data URL;
 *                 rendering differences between GPUs, drivers, and OS
 *                 font stacks produce a unique hash per device.
 *   getImageData — exposes raw RGBA pixel data; same uniqueness surface
 *                  as toDataURL but at the buffer level.
 *   toBlob       — async variant of toDataURL; produces the same
 *                  device-identifying bitmap, just delivered via callback.
 *
 * Methods not listed here (fillRect, lineTo, stroke, arc, drawImage, …)
 * are general-purpose drawing primitives.  They manipulate the canvas
 * state but do not extract image data, so they are never flagged.
 */
const SENSITIVE_METHODS = new Set(["toDataURL", "getImageData", "toBlob"]);

/**
 * Minimum call count that triggers a fingerprint flag.
 * Legitimate rendering rarely needs to extract pixel data more than a
 * handful of times; repeated extraction is the signature of a probe loop.
 */
const CALL_COUNT_THRESHOLD = 5;

/**
 * isCanvasFingerprintAttempt(ctxMethodName, callCount)
 *
 * Evaluates a canvas API call record and returns `true` when the pattern
 * matches a known fingerprinting probe:
 *
 *   1. `ctxMethodName` must be one of the data-extraction methods listed in
 *      SENSITIVE_METHODS (case-sensitive — canvas API is case-sensitive).
 *   2. `callCount` must strictly exceed CALL_COUNT_THRESHOLD (> 5).
 *      A callCount of exactly 5 is NOT flagged; 6 is the first positive case.
 *
 * Returns `false` — never throws — for every other input combination,
 * including:
 *   • Non-sensitive drawing methods regardless of call count
 *   • Call counts at or below the threshold
 *   • null / undefined / non-string method names
 *   • null / undefined / NaN / Infinity / negative call counts
 *
 * @param  {string} ctxMethodName   Canvas 2D / BitmapRenderer context method name
 * @param  {number} callCount       Number of times the method was invoked
 * @returns {boolean}  `true` if the pattern signals a fingerprint probe;
 *                     `false` in all other cases
 */
function isCanvasFingerprintAttempt(ctxMethodName, callCount) {
  // ── Guard 1: ctxMethodName must be a non-empty string ──────────────────────
  if (
    typeof ctxMethodName !== "string" ||
    ctxMethodName.trim() === ""
  ) {
    return false;
  }

  // ── Guard 2: callCount must be a finite, non-negative number ───────────────
  if (
    typeof callCount !== "number" ||
    !isFinite(callCount) ||   // rejects NaN and ±Infinity
    callCount < 0             // negative call counts are semantically invalid
  ) {
    return false;
  }

  // ── Detection: sensitive method called above the threshold ─────────────────
  // Both conditions must hold — a sensitive method at low frequency is
  // legitimate; a high-frequency call to a drawing primitive is not a probe.
  return SENSITIVE_METHODS.has(ctxMethodName) && callCount > CALL_COUNT_THRESHOLD;
}

module.exports = { isCanvasFingerprintAttempt };
