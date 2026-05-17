/**
 * Result structure for the HotGetJson cache.
 * Generic <T> allows for type-safe payloads across the hushh-webapp.
 */
export type HotGetJsonResult<T = any> = {
  status: number;
  payload: T;
};

type CacheEntry<T> = HotGetJsonResult<T> & {
  cachedAt: number;
};

export function createHotGetJsonCache(params: {
  freshTtlMs: number;
  staleTtlMs: number;
  maxEntries?: number; // Guard against memory leaks
}) {
  const cache = new Map<string, CacheEntry<any>>();
  const inflight = new Map<string, Promise<HotGetJsonResult<any>>>();

  /**
   * Internal helper to keep the cache size within limits.
   */
  function enforceLimit() {
    if (params.maxEntries && cache.size > params.maxEntries) {
      // Deletes the oldest entry (first key in the Map)
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }
  }

  /**
   * Reads a value from the cache if it hasn't expired.
   */
  function read<T>(
    key: string,
    options?: { allowStale?: boolean }
  ): HotGetJsonResult<T> | null {
    const cached = cache.get(key);
    if (!cached) return null;

    const ageMs = Date.now() - cached.cachedAt;
    const isFresh = ageMs <= params.freshTtlMs;
    const isStaleButAllowed = options?.allowStale && ageMs <= params.staleTtlMs;

    if (isFresh || isStaleButAllowed) {
      return {
        status: cached.status,
        payload: cached.payload as T,
      };
    }

    // Explicitly cleanup expired data
    cache.delete(key);
    return null;
  }

  /**
   * Writes a result to the cache and updates the timestamp.
   */
  function write<T>(key: string, value: HotGetJsonResult<T>): void {
    enforceLimit();
    cache.set(key, {
      ...value,
      cachedAt: Date.now(),
    });
  }

  /**
   * Retrieves an active promise for a specific key to prevent duplicate requests.
   */
  function getInflight<T>(key: string): Promise<HotGetJsonResult<T>> | null {
    return (inflight.get(key) as Promise<HotGetJsonResult<T>>) || null;
  }

  /**
   * Tracks a new request. Automatically clears itself from the inflight Map
   * once the promise settles (resolved or rejected).
   */
  function setInflight<T>(key: string, request: Promise<HotGetJsonResult<T>>): void {
    const trackedRequest = request.finally(() => {
      // Only delete if this specific request is still the one stored for this key
      if (inflight.get(key) === trackedRequest) {
        inflight.delete(key);
      }
    });

    inflight.set(key, trackedRequest);
  }

  /**
   * Manually cancels the tracking of an inflight request.
   */
  function clearInflight(key: string): void {
    inflight.delete(key);
  }

  return {
    read,
    write,
    getInflight,
    setInflight,
    clearInflight,
    /** Useful for logout or clearing state after hushh-research audits */
    clearAll: () => {
      cache.clear();
      inflight.clear();
    },
    getCacheSize: () => cache.size,
  };
}