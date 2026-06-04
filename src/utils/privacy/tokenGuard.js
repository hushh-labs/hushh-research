"use strict";

/**
 * isTokenExpired(tokenPayload, ttlInSeconds)
 *
 * Determines whether an access token has exceeded its permitted lifespan.
 *
 * Security posture — default-deny:
 *   Any input that is missing, null, non-numeric, NaN, Infinite, or
 *   structurally malformed causes the function to return `true` immediately,
 *   forcing the caller to reject the token rather than silently accept
 *   an unverifiable credential.
 *
 * Expiry logic:
 *   A token is considered expired when:
 *     Date.now() >= tokenPayload.createdAt + (ttlInSeconds * 1000)
 *   The `>=` boundary is intentional — at the exact millisecond of expiry
 *   the token is treated as expired, not valid.
 *
 * @param  {object}  tokenPayload   Object containing a `createdAt` field
 *                                  (Unix epoch in milliseconds, positive finite number)
 * @param  {number}  ttlInSeconds   Token time-to-live in seconds
 *                                  (non-negative finite number; 0 = expires immediately)
 * @returns {boolean}  `true` if the token is expired or the inputs are invalid;
 *                     `false` if the token is still within its valid window
 */
function isTokenExpired(tokenPayload, ttlInSeconds) {
  // ── Guard 1: tokenPayload must be a non-null, non-array plain object ────────
  if (
    tokenPayload === null ||
    tokenPayload === undefined ||
    typeof tokenPayload !== "object" ||
    Array.isArray(tokenPayload)
  ) {
    return true;
  }

  // ── Guard 2: createdAt must be a finite, positive number ────────────────────
  const createdAt = tokenPayload.createdAt;

  if (
    createdAt === null ||
    createdAt === undefined ||
    typeof createdAt !== "number" ||
    !isFinite(createdAt) ||    // rejects NaN and ±Infinity
    createdAt <= 0             // rejects zero, negative, and sub-epoch values
  ) {
    return true;
  }

  // ── Guard 3: ttlInSeconds must be a finite, non-negative number ─────────────
  if (
    ttlInSeconds === null ||
    ttlInSeconds === undefined ||
    typeof ttlInSeconds !== "number" ||
    !isFinite(ttlInSeconds) || // rejects NaN and ±Infinity
    ttlInSeconds < 0           // rejects negative durations
  ) {
    return true;
  }

  // ── Expiry check ─────────────────────────────────────────────────────────────
  // Convert TTL to milliseconds and add to the creation timestamp.
  // If the current wall-clock time has reached or passed the expiry instant,
  // the token is no longer valid.
  const expiresAt = createdAt + ttlInSeconds * 1000;
  return Date.now() >= expiresAt;
}

module.exports = { isTokenExpired };
