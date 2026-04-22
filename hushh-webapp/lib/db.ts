/**
 * Database Utility Library
 *
 * Handles storage of encrypted user data via the PKM backend.
 *
 * Architecture note:
 * - storeUserData() proxies to POST /api/pkm/store-domain on the backend.
 *   The backend stores the ciphertext blob without being able to decrypt it
 *   (BYOK guarantee — the vault key never leaves the client).
 * - Uses ApiService via apiJson() so routing works correctly on both
 *   web (Next.js proxy) and native platforms (iOS/Android via Capacitor).
 *
 * Removed:
 * - getAllFoodData() and getAllProfessionalData() were stubs that returned null.
 *   These domain-specific getters were removed from the backend
 *   (see db_proxy.py: "NOTE: /food/get and /professional/get removed;
 *   domain data is via PKM"). Domain data is now read via the PKM
 *   /api/pkm/domains/{userId} endpoint instead.
 */

import { apiJson, ApiError } from "@/lib/services/api-client";

interface StoreDomainResponse {
  success: boolean;
  message?: string;
}

/**
 * Persist an encrypted user data field to the PKM backend.
 *
 * The `value`, `iv`, and `tag` parameters are the AES-GCM ciphertext
 * components produced by the client-side vault encryption layer. The
 * backend stores them opaquely — it cannot decrypt the payload.
 *
 * @param userId  - Firebase UID of the data owner
 * @param key     - PKM domain path (e.g. "financial", "health")
 * @param value   - Base64-encoded AES-GCM ciphertext
 * @param iv      - Base64-encoded initialisation vector (12 bytes)
 * @param tag     - Base64-encoded authentication tag (16 bytes)
 * @returns true on success, false on failure (caller decides how to handle)
 */
export async function storeUserData(
  userId: string,
  key: string,
  value: string,
  iv: string,
  tag: string
): Promise<boolean> {
  try {
    await apiJson<StoreDomainResponse>("/api/pkm/store-domain", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        domain: key,
        encrypted_blob: {
          ciphertext: value,
          iv,
          tag,
          algorithm: "aes-256-gcm",
        },
        // Summary is intentionally empty — store-preferences stores
        // encrypted preference blobs, not queryable PKM domain data.
        summary: {},
      }),
    });
    return true;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(
        `[db] storeUserData failed for user ${userId} key ${key}:`,
        error.status,
        error.message
      );
    } else {
      console.error(`[db] storeUserData error for user ${userId} key ${key}:`, error);
    }
    return false;
  }
}