"use strict";

const crypto = require("node:crypto");

/**
 * Minimum safe byte length for a nonce.  Any invalid, zero, or negative
 * input falls back to this value.
 */
const BASELINE_BYTE_LENGTH = 16;

/**
 * generateRequestNonce(byteLength = 16)
 *
 * Generates a cryptographically secure hexadecimal nonce token using
 * Node's native crypto.randomBytes().  Each byte is encoded as two
 * lowercase hex characters, so the returned string length is always
 * byteLength × 2.
 *
 * Fallback rules — all invalid inputs silently use BASELINE_BYTE_LENGTH (16):
 *   - non-numeric types  (null, undefined, string, boolean, object …)
 *   - NaN or ±Infinity
 *   - zero or any negative number
 *   - float values are floored; if the floor result is < 1 → baseline
 *
 * @param  {number} [byteLength=16]  — desired entropy in bytes
 * @returns {string}                 — lowercase hex string of length byteLength × 2
 */
function generateRequestNonce(byteLength = 16) {
  let size = BASELINE_BYTE_LENGTH;

  if (
    typeof byteLength === "number" &&
    Number.isFinite(byteLength) &&
    byteLength > 0
  ) {
    const floored = Math.floor(byteLength);
    size = floored >= 1 ? floored : BASELINE_BYTE_LENGTH;
  }

  return crypto.randomBytes(size).toString("hex");
}

module.exports = { generateRequestNonce, BASELINE_BYTE_LENGTH };
