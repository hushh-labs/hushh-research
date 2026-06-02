"use strict";

/**
 * src/api/consent.js
 *
 * Framework-agnostic consent action handler.
 *
 * Wired to the real consent-action call path in the Hushh web app:
 *   hushh-webapp/app/api/consent/pending/deny/route.ts
 *   hushh-webapp/app/api/consent/pending/approve/route.ts
 *   hushh-webapp/app/api/consent/revoke/route.ts
 *
 * Each of those routes only exports a POST handler. Any other HTTP method
 * reaches Next.js's default 405 handler automatically.  This module makes
 * that contract explicit and testable at the unit level, mirroring the
 * same field-level guards already present in the JS route handlers and
 * the Python consent-protocol Pydantic models they forward to.
 */

/** Only POST is authorised for consent actions. */
const ALLOWED_METHODS = Object.freeze(new Set(["POST"]));

// ── Internal body validator ────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validates a consent action request body.
 *
 * Mirrors the field guards in:
 *   pending/deny/route.ts    — if (!userId || !requestId) → 400
 *   pending/approve/route.ts — if (!userId || !requestId) → 400
 *                              if ("exportKey" in body)    → 400  (ZK mode)
 *   api-service.ts           — if (!vaultOwnerToken)       → 401
 *   Python CancelConsentRequest (Pydantic): userId: str, requestId: str
 *
 * @param  {*} body
 * @returns {{ valid: boolean, error?: string }}
 */
function validateBody(body) {
  if (!isPlainObject(body)) {
    return { valid: false, error: "Request body must be a non-null plain object" };
  }

  // userId — mirrors pending/deny/route.ts: if (!userId) → 400
  if (!("userId" in body) || typeof body.userId !== "string" || !body.userId.trim()) {
    return { valid: false, error: "userId must be a non-empty string" };
  }

  // requestId — mirrors pending/deny/route.ts: if (!requestId) → 400
  if (!("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()) {
    return { valid: false, error: "requestId must be a non-empty string" };
  }

  // vaultOwnerToken — mirrors api-service.ts: if (!vaultOwnerToken) → 401
  if (
    !("vaultOwnerToken" in body) ||
    typeof body.vaultOwnerToken !== "string" ||
    !body.vaultOwnerToken.trim()
  ) {
    return { valid: false, error: "vaultOwnerToken must be a non-empty string" };
  }

  // ZK mode guard — mirrors pending/approve/route.ts:
  //   if ("exportKey" in body) → 400 "Plaintext exportKey not accepted"
  if ("exportKey" in body) {
    return {
      valid: false,
      error: "exportKey is not accepted — plaintext keys violate the zero-knowledge consent contract",
    };
  }

  return { valid: true };
}

// ── Public handler ─────────────────────────────────────────────────────────────

/**
 * handleConsentAction(req)
 *
 * Validates an incoming consent action request and returns a structured
 * response descriptor.  The function is framework-agnostic: it accepts
 * a plain object with { method, body } properties so it can be exercised
 * directly in unit tests without spinning up an HTTP server.
 *
 * The same handler can be wired as an Express middleware:
 *   app.post("/api/consent/action", (req, res) => {
 *     const { statusCode, body } = handleConsentAction(req);
 *     res.status(statusCode).json(body);
 *   });
 *
 * Response descriptors:
 *   405 { error: "Method Not Allowed", allowed: ["POST"] }
 *       — any non-POST HTTP method
 *   400 { error: "<field validation reason>" }
 *       — structurally invalid body
 *   200 { accepted: true }
 *       — valid consent action payload accepted for forwarding
 *
 * @param  {{ method: string, body?: object }} req
 * @returns {{ statusCode: number, body: object }}
 */
function handleConsentAction(req) {
  const method = String(req?.method ?? "").trim().toUpperCase();

  // ── Method guard ─────────────────────────────────────────────────────────
  if (!ALLOWED_METHODS.has(method)) {
    return {
      statusCode: 405,
      body: {
        error: "Method Not Allowed",
        allowed: [...ALLOWED_METHODS],
      },
    };
  }

  // ── Body validation ──────────────────────────────────────────────────────
  const validation = validateBody(req?.body);
  if (!validation.valid) {
    return {
      statusCode: 400,
      body: { error: validation.error },
    };
  }

  return {
    statusCode: 200,
    body: { accepted: true },
  };
}

module.exports = { handleConsentAction, ALLOWED_METHODS };
