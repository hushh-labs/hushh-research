"use client";

/**
 * Soft, client-side "show once" gate for the One Setup hub.
 *
 * This is intentionally a localStorage flag (v1) so it requires no backend
 * schema change. It only governs a one-time, dismissible nudge into
 * `/one/setup` on the user's first organic login; it never blocks access and
 * degrades to "already seen" whenever storage is unavailable (fail-open for
 * navigation, so a storage error can never trap a user on the setup route).
 */

const STORAGE_PREFIX = "hushh.one_setup_seen.";

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export class OneSetupGateService {
  /** Whether the user has already seen (completed or dismissed) the setup nudge. */
  static hasSeen(userId: string): boolean {
    if (!userId) return true;
    const store = safeStorage();
    if (!store) return true; // fail-open: never strand a user on setup
    try {
      return store.getItem(storageKey(userId)) !== null;
    } catch {
      return true;
    }
  }

  /** Mark the setup nudge as seen so it is not shown again. */
  static markSeen(userId: string): void {
    if (!userId) return;
    const store = safeStorage();
    if (!store) return;
    try {
      store.setItem(storageKey(userId), String(Date.now()));
    } catch {
      // best-effort; ignore quota/availability errors
    }
  }

  /** Clear the seen flag (primarily for tests and account reset flows). */
  static reset(userId: string): void {
    if (!userId) return;
    const store = safeStorage();
    if (!store) return;
    try {
      store.removeItem(storageKey(userId));
    } catch {
      // ignore
    }
  }
}
