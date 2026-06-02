"use strict";

/**
 * src/database/preferenceStore.js
 *
 * Preference storage adapter — mirrors the error-handling contract of
 * hushh-webapp/lib/db.ts → storeUserData():
 *
 *   "returns true on success, false on failure (caller decides how to handle)"
 *
 * The function NEVER throws.  All error paths return false so the calling
 * application layer is safe against unhandled database crashes regardless
 * of what goes wrong at the storage boundary.
 *
 * Two-phase failure model (matches lib/db.ts behaviour):
 *
 *   Phase 1 — in-process guards (no I/O attempted):
 *     • missing vaultOwnerToken         → false  (mirrors lib/db.ts early guard)
 *     • missing / empty userId          → false
 *     • missing / empty domain key      → false
 *     • missing / empty ciphertext      → false
 *     • missing / empty iv              → false
 *     • missing / empty tag             → false
 *     • non-plain-object payload        → false
 *
 *   Phase 2 — transport failure (I/O attempted, error caught):
 *     • transport throws synchronously  → false  (caught in try/catch)
 *     • transport rejects (async)       → false  (caught in try/catch)
 *     • transport resolves non-ok (4xx/5xx) → false
 *
 *   Phase 3 — success:
 *     • transport resolves ok           → true
 *
 * The `transport` option exists exclusively for unit tests so that callers
 * can inject a failing transport without a live database connection.  In
 * production the default transport is used (fetches the PKM store-domain
 * endpoint via the Next.js API proxy layer).
 */

const PKM_STORE_ENDPOINT = "/api/pkm/store-domain";

// ── Payload validator ──────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * validateStorePayload(payload)
 *
 * Validates the encrypted-blob write payload structure before any I/O.
 * All five fields must be non-empty strings (they are Base64-encoded
 * AES-GCM components from the client-side vault encryption layer).
 *
 * @param  {*} payload
 * @returns {{ valid: boolean, error?: string }}
 */
function validateStorePayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, error: "Payload must be a non-null plain object" };
  }
  if (!isNonEmptyString(payload.userId)) {
    return { valid: false, error: "userId must be a non-empty string" };
  }
  if (!isNonEmptyString(payload.domain)) {
    return { valid: false, error: "domain must be a non-empty string" };
  }
  if (!isNonEmptyString(payload.ciphertext)) {
    return { valid: false, error: "ciphertext must be a non-empty string" };
  }
  if (!isNonEmptyString(payload.iv)) {
    return { valid: false, error: "iv must be a non-empty string" };
  }
  if (!isNonEmptyString(payload.tag)) {
    return { valid: false, error: "tag must be a non-empty string" };
  }
  return { valid: true };
}

// ── Default transport (production) ────────────────────────────────────────────

async function defaultTransport({ endpoint, token, body }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Storage request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`
    );
  }

  return response.json();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * storePreference(payload, options)
 *
 * Validates an encrypted preference payload and persists it to the PKM
 * backend storage layer via the configured transport.
 *
 * @param  {{ userId, domain, ciphertext, iv, tag }} payload
 * @param  {{ vaultOwnerToken: string, transport?: function }} options
 * @returns {Promise<boolean>}  true = stored, false = any failure
 */
async function storePreference(payload, options = {}) {
  // ── Phase 1: in-process guards (no I/O) ──────────────────────────────────

  // Guard mirrors lib/db.ts: "missing vault-owner token" → return false
  if (!isNonEmptyString(String(options.vaultOwnerToken ?? ""))) {
    console.error("[preferenceStore] write rejected: missing vault-owner token");
    return false;
  }

  // Guard: validate encrypted-blob fields before reaching the wire
  const validation = validateStorePayload(payload);
  if (!validation.valid) {
    console.error(`[preferenceStore] write rejected: ${validation.error}`);
    return false;
  }

  // ── Phase 2: transport (I/O, errors caught) ───────────────────────────────

  const transport = options.transport ?? defaultTransport;

  try {
    await transport({
      endpoint: PKM_STORE_ENDPOINT,
      token:    options.vaultOwnerToken,
      body:     {
        user_id: payload.userId,
        domain:  payload.domain,
        encrypted_blob: {
          ciphertext: payload.ciphertext,
          iv:         payload.iv,
          tag:        payload.tag,
          algorithm:  "aes-256-gcm",
        },
        summary: {},
      },
    });
    return true;
  } catch (error) {
    // Mirrors lib/db.ts catch block — log and return false, never re-throw
    console.error(
      "[preferenceStore] transport error:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

module.exports = { storePreference, validateStorePayload };
