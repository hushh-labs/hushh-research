"use strict";

/**
 * Returns true only for plain (non-null, non-array) objects.
 * Arrays, null, and primitives all return false.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * validateConsentPayload(payload)
 *
 * Enforces immutable structural constraints on incoming user privacy-preference
 * objects in support of the Hushh data-consent protocol.
 *
 * Expected shape:
 *   {
 *     userId      : string  (non-empty)
 *     timestamp   : number  (non-negative integer — unix epoch seconds)
 *     preferences : {
 *       functional : boolean
 *       analytics  : boolean
 *       marketing  : boolean
 *     }
 *   }
 *
 * Returns:
 *   { valid: true,  sanitized: payload }          — on a fully conformant payload
 *   { valid: false, error: "<reason>" }           — on any structural violation
 *
 * Never throws.  All error paths return a result object so callers need no
 * try/catch and the application cannot crash from a malformed inbound payload.
 */
function validateConsentPayload(payload) {
  // ── Top-level shape ────────────────────────────────────────────────────────

  if (!isPlainObject(payload)) {
    return {
      valid: false,
      error: "Payload must be a non-null plain object",
    };
  }

  // ── userId ─────────────────────────────────────────────────────────────────

  if (!("userId" in payload)) {
    return { valid: false, error: "Missing required field: userId" };
  }
  if (typeof payload.userId !== "string") {
    return { valid: false, error: "userId must be a string" };
  }
  if (payload.userId.trim() === "") {
    return { valid: false, error: "userId must be a non-empty string" };
  }

  // ── timestamp ──────────────────────────────────────────────────────────────

  if (!("timestamp" in payload)) {
    return { valid: false, error: "Missing required field: timestamp" };
  }
  if (typeof payload.timestamp !== "number") {
    return { valid: false, error: "timestamp must be a number" };
  }
  if (!Number.isInteger(payload.timestamp) || payload.timestamp < 0) {
    return {
      valid: false,
      error: "timestamp must be a non-negative integer unix timestamp",
    };
  }

  // ── preferences ────────────────────────────────────────────────────────────

  if (!("preferences" in payload)) {
    return { valid: false, error: "Missing required field: preferences" };
  }
  if (!isPlainObject(payload.preferences)) {
    return { valid: false, error: "preferences must be a plain object" };
  }

  for (const key of ["functional", "analytics", "marketing"]) {
    if (!(key in payload.preferences)) {
      return {
        valid: false,
        error: `Missing required preference switch: preferences.${key}`,
      };
    }
    if (typeof payload.preferences[key] !== "boolean") {
      return {
        valid: false,
        error: `preferences.${key} must be a boolean`,
      };
    }
  }

  // ── All constraints satisfied ──────────────────────────────────────────────

  return { valid: true, sanitized: payload };
}

module.exports = { validateConsentPayload };
