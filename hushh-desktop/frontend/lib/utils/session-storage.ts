/**
 * Platform-Aware Session Storage
 *
 * On iOS (Capacitor), sessionStorage doesn't work reliably in WKWebView.
 * This utility uses localStorage with a session prefix on native platforms.
 *
 * SECURITY NOTE: On native, we use localStorage which persists.
 * This is acceptable because native apps have better app-level isolation.
 */

function isNativeCapacitorPlatform(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      (
        window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
      ).Capacitor?.isNativePlatform?.()
  );
}

const SESSION_PREFIX = "_session_";
const BOOT_ID_KEY = "__hushh_boot_id__";

/**
 * On native Capacitor, session storage falls back to localStorage which persists
 * across app restarts. This generates a boot ID on each cold start and purges
 * all _session_ keys when a mismatch is detected, restoring session semantics.
 */
function purgeStaleSessionKeysOnNative(): void {
  if (typeof window === "undefined") return;
  if (!isNativeCapacitorPlatform()) return;

  try {
    const storage = window.localStorage;
    const currentBootId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const storedBootId = storage.getItem(BOOT_ID_KEY);

    if (storedBootId !== null && storedBootId !== currentBootId) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(SESSION_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      if (keysToRemove.length > 0) {
        keysToRemove.forEach((key) => storage.removeItem(key));
        console.info(
          `[SessionStorage] Cold-start purge: cleared ${keysToRemove.length} stale session keys`,
        );
      }
    }

    storage.setItem(BOOT_ID_KEY, currentBootId);
  } catch (e) {
    console.warn("[SessionStorage] Boot ID check failed:", e);
  }
}

// Run purge on module load (app startup)
purgeStaleSessionKeysOnNative();

function getSessionLikeStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    if (isNativeCapacitorPlatform()) {
      return window.localStorage;
    }
    return window.sessionStorage;
  } catch (e) {
    console.warn("[SessionStorage] Failed to access session-like storage:", e);
    return null;
  }
}

function getPersistentStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch (e) {
    console.warn("[SessionStorage] Failed to access local storage:", e);
    return null;
  }
}

/**
 * Set a session value (uses localStorage on iOS, sessionStorage on web)
 */
export function setSessionItem(key: string, value: string): void {
  const storage = getSessionLikeStorage();
  if (!storage) return;

  try {
    if (isNativeCapacitorPlatform()) {
      storage.setItem(SESSION_PREFIX + key, value);
    } else {
      storage.setItem(key, value);
    }
  } catch (e) {
    console.warn("[SessionStorage] Failed to set item:", e);
  }
}

/**
 * Get a session value
 * On native: checks prefixed key first, then raw key as fallback (backward compatibility)
 */
export function getSessionItem(key: string): string | null {
  const storage = getSessionLikeStorage();
  if (!storage) return null;

  try {
    if (isNativeCapacitorPlatform()) {
      return storage.getItem(SESSION_PREFIX + key) || storage.getItem(key);
    }
    return storage.getItem(key);
  } catch (e) {
    console.warn("[SessionStorage] Failed to get item:", e);
    return null;
  }
}

/**
 * Remove a session value
 */
export function removeSessionItem(key: string): void {
  const storage = getSessionLikeStorage();
  if (!storage) return;

  try {
    if (isNativeCapacitorPlatform()) {
      storage.removeItem(SESSION_PREFIX + key);
    } else {
      storage.removeItem(key);
    }
  } catch (e) {
    console.warn("[SessionStorage] Failed to remove item:", e);
  }
}

/**
 * Remove session values by prefix
 */
export function removeSessionItemsByPrefix(prefix: string): void {
  const storage = getSessionLikeStorage();
  if (!storage) return;

  try {
    const normalizedPrefix = isNativeCapacitorPlatform()
      ? SESSION_PREFIX + prefix
      : prefix;
    const keysToRemove: string[] = [];

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(normalizedPrefix)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => storage.removeItem(key));
  } catch (e) {
    console.warn("[SessionStorage] Failed to remove prefixed items:", e);
  }
}

/**
 * Clear all session values
 */
export function clearSessionStorage(): void {
  const storage = getSessionLikeStorage();
  if (!storage) return;

  try {
    if (isNativeCapacitorPlatform()) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(SESSION_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => storage.removeItem(key));
    } else {
      storage.clear();
    }
  } catch (e) {
    console.warn("[SessionStorage] Failed to clear:", e);
  }
}

export function setLocalItem(key: string, value: string): void {
  const storage = getPersistentStorage();
  if (!storage) return;

  try {
    storage.setItem(key, value);
  } catch (e) {
    console.warn("[SessionStorage] Failed to set local item:", e);
  }
}

export function getLocalItem(key: string): string | null {
  const storage = getPersistentStorage();
  if (!storage) return null;

  try {
    return storage.getItem(key);
  } catch (e) {
    console.warn("[SessionStorage] Failed to get local item:", e);
    return null;
  }
}

export function removeLocalItem(key: string): void {
  const storage = getPersistentStorage();
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch (e) {
    console.warn("[SessionStorage] Failed to remove local item:", e);
  }
}

export function removeLocalItems(keys: string[]): void {
  for (const key of keys) {
    removeLocalItem(key);
  }
}

export function clearLocalStorage(): void {
  const storage = getPersistentStorage();
  if (!storage) return;

  try {
    storage.clear();
  } catch (e) {
    console.warn("[SessionStorage] Failed to clear local storage:", e);
  }
}

export function clearLocalStorageKeys(keys: string[]): void {
  removeLocalItems(keys);
}

export const isNativePlatform = isNativeCapacitorPlatform;
