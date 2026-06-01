"use strict";

/**
 * Returns true only for plain (non-null, non-array) objects.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * validateConsentPayload(payload)
 *
 * Validates a consent action payload at the JS API boundary — BEFORE
 * it is forwarded to the Python consent-protocol backend.
 *
 * Wired to the real consent-action call path:
 *
 *   hushh-webapp/lib/services/api-service.ts
 *     approvePendingConsent()  → POST /api/consent/pending/approve
 *     denyPendingConsent()     → POST /api/consent/pending/deny
 *
 * Mirrors the field-level guards already in the JS route handlers and
 * the Python Pydantic models they forward to:
 *
 *   pending/deny/route.ts:
 *     if (!userId || !requestId) → 400
 *   pending/approve/route.ts:
 *     if (!userId || !requestId) → 400
 *     if ("exportKey" in body)   → 400 (ZK mode — no plaintext keys)
 *   api-service.ts:
 *     if (!vaultOwnerToken)      → 401
 *   Python consent.py CancelConsentRequest (Pydantic):
 *     userId: str, requestId: str
 *
 * Required payload shape:
 *   {
 *     userId:          string (non-empty)
 *     requestId:       string (non-empty)
 *     vaultOwnerToken: string (non-empty)
 *   }
 *
 * Returns:
 *   { valid: true,  sanitized: payload }     — fully conformant payload
 *   { valid: false, error: "<reason>" }      — any structural violation
 *
 * Never throws — all error paths return a result object.
 *
 * @param  {object|*} payload
 * @returns {{ valid: boolean, sanitized?: object, error?: string }}
 */
function validateConsentPayload(payload) {
  // ── Top-level structure ────────────────────────────────────────────────────
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      error: "Payload must be a non-null plain object",
    };
  }

  // ── userId ─────────────────────────────────────────────────────────────────
  // mirrors: pending/deny/route.ts  if (!userId) → 400
  //          Python CancelConsentRequest: userId: str
  if (!("userId" in payload)) {
    return { valid: false, error: "Missing required field: userId" };
  }
  if (typeof payload.userId !== "string") {
    return { valid: false, error: "userId must be a string" };
  }
  if (!payload.userId.trim()) {
    return { valid: false, error: "userId must be a non-empty string" };
  }

  // ── requestId ──────────────────────────────────────────────────────────────
  // mirrors: pending/deny/route.ts  if (!requestId) → 400
  //          pending/approve/route.ts  if (!requestId) → 400
  //          Python CancelConsentRequest: requestId: str
  if (!("requestId" in payload)) {
    return { valid: false, error: "Missing required field: requestId" };
  }
  if (typeof payload.requestId !== "string") {
    return { valid: false, error: "requestId must be a string" };
  }
  if (!payload.requestId.trim()) {
    return { valid: false, error: "requestId must be a non-empty string" };
  }

  // ── vaultOwnerToken ────────────────────────────────────────────────────────
  // mirrors: api-service.ts  if (!vaultOwnerToken) → 401
  if (!("vaultOwnerToken" in payload)) {
    return { valid: false, error: "Missing required field: vaultOwnerToken" };
  }
  if (typeof payload.vaultOwnerToken !== "string") {
    return { valid: false, error: "vaultOwnerToken must be a string" };
  }
  if (!payload.vaultOwnerToken.trim()) {
    return { valid: false, error: "vaultOwnerToken must be a non-empty string" };
  }

  // ── ZK mode guard ──────────────────────────────────────────────────────────
  // mirrors: pending/approve/route.ts
  //   if ("exportKey" in body) → 400 "Plaintext exportKey is not accepted in
  //                                    strict zero-knowledge mode"
  if ("exportKey" in payload) {
    return {
      valid: false,
      error: "exportKey is not accepted — plaintext keys violate the zero-knowledge consent contract",
    };
  }

  return { valid: true, sanitized: payload };
}

module.exports = { validateConsentPayload };
