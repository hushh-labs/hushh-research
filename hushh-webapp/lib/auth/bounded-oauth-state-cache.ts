type OAuthStateCacheEntry<TValue> = {
  value: TValue;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
};

type BoundedOAuthStateCacheOptions = {
  maxSize?: number;
  ttlMs?: number;
};

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createBoundedOAuthStateCache<TValue>({
  maxSize = DEFAULT_MAX_SIZE,
  ttlMs = DEFAULT_TTL_MS,
}: BoundedOAuthStateCacheOptions = {}) {
  const entries = new Map<string, OAuthStateCacheEntry<TValue>>();

  const cleanupExpiredOAuthStates = () => {
    const now = Date.now();

    for (const [key, entry] of entries.entries()) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  };

  const enforceMaxSize = () => {
    while (entries.size > maxSize) {
      const oldestEntry = [...entries.entries()].sort(
        ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt
      )[0];

      if (!oldestEntry) {
        return;
      }

      entries.delete(oldestEntry[0]);
    }
  };

  const setOAuthState = (key: string, value: TValue) => {
    cleanupExpiredOAuthStates();

    const now = Date.now();

    entries.set(key, {
      value,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlMs,
    });

    enforceMaxSize();
  };

  const getOAuthState = (key: string) => {
    cleanupExpiredOAuthStates();

    const entry = entries.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();

    if (entry.expiresAt <= now) {
      entries.delete(key);
      return null;
    }

    entries.set(key, {
      ...entry,
      lastAccessedAt: now,
    });

    return entry.value;
  };

  const deleteOAuthState = (key: string) => {
    entries.delete(key);
  };

  const resetOAuthStateCache = () => {
    entries.clear();
  };

  const getOAuthStateCacheSnapshot = () => {
    cleanupExpiredOAuthStates();

    return {
      size: entries.size,
      maxSize,
      ttlMs,
      keys: [...entries.keys()],
    };
  };

  return {
    setOAuthState,
    getOAuthState,
    deleteOAuthState,
    cleanupExpiredOAuthStates,
    resetOAuthStateCache,
    getOAuthStateCacheSnapshot,
  };
}