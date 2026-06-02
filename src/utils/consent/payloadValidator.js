"use strict";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * validateConsentPayload(payload)
 *
 * Validates a consent action payload at the JS API boundary — BEFORE it is
 * forwarded to the Python consent-protocol backend.
 *
 * Wired to the real consent-action call path:
 *   hushh-webapp/lib/services/api-service.ts
 *     approvePendingConsent / denyPendingConsent
 *       → POST /api/consent/pending/approve|deny
 *
 * Mirrors the field-level guards already in the JS route handlers and the
 * Python Pydantic models they forward to:
 *   pending/deny/route.ts:    if (!userId || !requestId)   → 400
 *   pending/approve/route.ts: if (!userId || !requestId)   → 400
 *                             if ("exportKey" in body)      → 400 (ZK mode)
 *   api-service.ts:           if (!vaultOwnerToken)         → 401
 *   Python CancelConsentRequest: userId: str, requestId: str
 *
 * Required shape: { userId: string, requestId: string, vaultOwnerToken: string }
 *
 * Returns { valid: true, sanitized: payload } or { valid: false, error: string }.
 * Never throws.
 */
function validateConsentPayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, error: "Payload must be a non-null plain object" };
  }

  if (!("userId" in payload)) {
    return { valid: false, error: "Missing required field: userId" };
  }
  if (typeof payload.userId !== "string") {
    return { valid: false, error: "userId must be a string" };
  }
  if (!payload.userId.trim()) {
    return { valid: false, error: "userId must be a non-empty string" };
  }

  if (!("requestId" in payload)) {
    return { valid: false, error: "Missing required field: requestId" };
  }
  if (typeof payload.requestId !== "string") {
    return { valid: false, error: "requestId must be a string" };
  }
  if (!payload.requestId.trim()) {
    return { valid: false, error: "requestId must be a non-empty string" };
  }

  if (!("vaultOwnerToken" in payload)) {
    return { valid: false, error: "Missing required field: vaultOwnerToken" };
  }
  if (typeof payload.vaultOwnerToken !== "string") {
    return { valid: false, error: "vaultOwnerToken must be a string" };
  }
  if (!payload.vaultOwnerToken.trim()) {
    return { valid: false, error: "vaultOwnerToken must be a non-empty string" };
  }

  // ZK mode guard — mirrors pending/approve/route.ts
  if ("exportKey" in payload) {
    return {
      valid: false,
      error: "exportKey is not accepted — plaintext keys violate the zero-knowledge consent contract",
    };
  }

  return { valid: true, sanitized: payload };
}

module.exports = { validateConsentPayload };
