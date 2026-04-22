/**
 * Database Utility Library
 *
 * Handles storage of encrypted user data via the PKM backend.
 *
 * Architecture note:
 * - storeUserData() proxies to POST /api/pkm/store-domain on the backend.
 *   The backend stores the ciphertext blob without being able to decrypt it
 *   (BYOK guarantee — the vault key never leaves the client).
 *
 * Removed:
 * - getAllFoodData() and getAllProfessionalData() were stubs that returned null.
 *   These domain-specific getters were removed from the backend
 *   (see db_proxy.py: "NOTE: /food/get and /professional/get removed;
 *   domain data is via PKM"). Domain data is now read via the PKM
 *   /api/pkm/domains/{userId} endpoint instead.
 */

const PKM_STORE_TIMEOUT_MS = 30_000;

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PKM_STORE_TIMEOUT_MS);

    const response = await fetch("/api/pkm/store-domain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        domain: key,
        encrypted_blob: {
          ciphertext: value,
          iv,
          tag,
          algorithm: "aes-256-gcm",
        },
        // Summary is intentionally empty — the caller (store-preferences)
        // stores encrypted preference blobs, not queryable PKM domain data.
        summary: {},
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `[db] storeUserData failed for user ${userId} key ${key}:`,
        response.status,
        errorText
      );
      return false;
    }

    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error(
        `[db] storeUserData timed out after ${PKM_STORE_TIMEOUT_MS}ms for user ${userId} key ${key}`
      );
    } else {
      console.error(`[db] storeUserData error for user ${userId} key ${key}:`, error);
    }
    return false;
  }
}