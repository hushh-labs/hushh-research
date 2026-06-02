"use strict";

/**
 * src/database/preferenceStore.js
 *
 * Preference storage adapter.
 *
 * Mirrors the error-handling contract of hushh-webapp/lib/db.ts → storeUserData():
 *   "returns true on success, false on failure (caller decides how to handle)"
 *
 * The function NEVER throws. Every failure path returns false so the
 * application layer is safe against unhandled database crashes regardless
 * of what goes wrong at the storage boundary.
 *
 * Production path this adapter covers:
 *   hushh-webapp/app/api/vault/store-preferences/route.ts
 *     → storeUserData(userId, key, value, iv, tag, { vaultOwnerToken })
 *     → POST /api/pkm/store-domain  (PKM backend, AES-GCM encrypted blob)
 *
 * Two-phase failure model (identical to lib/db.ts):
 *
 *   Phase 1 — in-process guards (no I/O attempted):
 *     missing vaultOwnerToken   → false  (mirrors lib/db.ts line 55-57)
 *     invalid payload fields    → false  (pre-transport validation)
 *
 *   Phase 2 — transport failure (I/O attempted, error caught):
 *     transport throws / rejects → false  (mirrors lib/db.ts catch block)
 *
 *   Success:
 *     transport resolves        → true
 *
 * The `options.transport` seam is the production module's own
 * dependency-injection point — in production the default fetch-based
 * transport is used; in unit tests a failing transport is injected to
 * force real error-handling code paths without a live database.
 */

const PKM_ENDPOINT = "/api/pkm/store-domain";

// ── Internal helpers ───────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── Payload validator ──────────────────────────────────────────────────────────

/**
 * validatePayload(payload)
 *
 * Validates the encrypted-blob fields before any I/O is attempted.
 * All five fields must be non-empty strings — they are Base64-encoded
 * AES-GCM components produced by the client-side vault encryption layer.
 *
 * @param  {*} payload
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, error: "payload must be a non-null plain object" };
  }
  const required = ["userId", "domain", "ciphertext", "iv", "tag"];
  for (const field of required) {
    if (!isNonEmptyString(payload[field])) {
      return { valid: false, error: `${field} must be a non-empty string` };
    }
  }
  return { valid: true };
}

// ── Default (production) transport ────────────────────────────────────────────

async function defaultTransport({ endpoint, token, body }) {
  const res = await fetch(endpoint, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Storage write failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`
    );
  }
  return res.json();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * storePreference(payload, options)
 *
 * Validates an encrypted preference payload and persists it through the
 * configured transport. Returns a boolean — never throws.
 *
 * @param  {{ userId, domain, ciphertext, iv, tag }} payload
 * @param  {{ vaultOwnerToken: string, transport?: function }}   options
 * @returns {Promise<boolean>}  true = stored successfully, false = any failure
 */
async function storePreference(payload, options = {}) {
  // ── Phase 1: in-process guards ────────────────────────────────────────────
  if (!isNonEmptyString(String(options.vaultOwnerToken ?? ""))) {
    console.error("[preferenceStore] write rejected: missing vault-owner token");
    return false;
  }

  const check = validatePayload(payload);
  if (!check.valid) {
    console.error(`[preferenceStore] write rejected: ${check.error}`);
    return false;
  }

  // ── Phase 2: transport (errors absorbed) ──────────────────────────────────
  const transport = options.transport ?? defaultTransport;
  try {
    await transport({
      endpoint: PKM_ENDPOINT,
      token:    options.vaultOwnerToken,
      body: {
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
  } catch (err) {
    // Mirrors lib/db.ts catch block — log and return false, never re-throw
    console.error(
      "[preferenceStore] transport error:",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

module.exports = { storePreference, validatePayload };
