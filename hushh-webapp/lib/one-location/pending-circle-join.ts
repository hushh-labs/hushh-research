/**
 * Codes are shown grouped (`96RE-HUNF-KMVX`) and typed however people type
 * them. The server normalises the same way before hashing, so storing the
 * normalised form keeps a pasted code and a hand-typed one identical.
 */
export function normalizeCircleCode(raw: string): string {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

/**
 * A circle code accepted during onboarding, held until it can be redeemed.
 *
 * Joining a circle needs a vault owner token, and the vault is only created
 * once the /one/setup wizard finishes. Someone who arrives holding a code meets
 * onboarding first, so the accept and the redeem cannot happen at the same
 * moment. The code is parked here and redeemed the first time a vault token
 * exists, which is the same shape as every other pre-vault decision in setup:
 * capture the intent now, settle it when the vault arrives.
 *
 * Per user, because two accounts on one device must never inherit each other's
 * pending join. A code is not a secret to the person holding it -- they were
 * given it -- so device-local storage is the right weight here.
 */
const PENDING_JOIN_KEY_PREFIX = "one_location_pending_circle_join_v1";

function storageKey(userId: string): string {
  return `${PENDING_JOIN_KEY_PREFIX}:${userId}`;
}

export function rememberPendingCircleJoin(
  userId: string,
  code: string,
): boolean {
  const normalized = normalizeCircleCode(code);
  if (!userId || !normalized) return false;
  try {
    window.localStorage.setItem(storageKey(userId), normalized);
    return true;
  } catch {
    // Private mode or a full quota. The person can still join from the hub,
    // so this degrades to "not remembered" rather than to an error.
    return false;
  }
}

export function readPendingCircleJoin(userId: string): string | null {
  if (!userId) return null;
  try {
    const stored = window.localStorage.getItem(storageKey(userId));
    return stored ? normalizeCircleCode(stored) || null : null;
  } catch {
    return null;
  }
}

export function clearPendingCircleJoin(userId: string): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(storageKey(userId));
  } catch {
    // Nothing to do: a stale entry costs one no-op redeem attempt next load,
    // which the server rejects harmlessly if the code is spent.
  }
}
