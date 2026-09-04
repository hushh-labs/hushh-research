"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { logRequestAudit } from "@/lib/cache/request-audit-log";
import { CacheService, type CacheSnapshot } from "@/lib/services/cache-service";

const inflightRequests = new Map<string, Promise<unknown>>();

type UseStaleResourceOptions<T> = {
  cacheKey: string;
  enabled?: boolean;
  load: (options?: { force?: boolean }) => Promise<T>;
  resourceLabel?: string;
  refreshKey?: string;
  /** Keep the last safe in-memory value visible while a mutation refreshes it. */
  retainOnInvalidate?: boolean;
};

type UseStaleResourceResult<T> = {
  data: T | null;
  snapshot: CacheSnapshot<T> | null;
  loading: boolean;
  refreshing: boolean;
  /** Cache was invalidated; an opted-in stale view may still be rendering. */
  invalidated: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<T | null>;
};

export function useStaleResource<T>({
  cacheKey,
  enabled = true,
  load,
  resourceLabel,
  refreshKey = "",
  retainOnInvalidate = false,
}: UseStaleResourceOptions<T>): UseStaleResourceResult<T> {
  const cache = useMemo(() => CacheService.getInstance(), []);
  const loadRef = useRef(load);
  const label = resourceLabel ? `${resourceLabel}:hook` : cacheKey;
  const initialSnapshot = useMemo(
    () => cache.peek<T>(cacheKey),
    [cache, cacheKey],
  );
  // State below is populated asynchronously. Tag it with the cache key that
  // produced it so a user/resource switch can never render the previous key's
  // value for one frame while the reset effect is still pending.
  const [renderedCacheKey, setRenderedCacheKey] = useState(cacheKey);
  const [data, setData] = useState<T | null>(initialSnapshot?.data ?? null);
  const dataRef = useRef<T | null>(initialSnapshot?.data ?? null);
  const [snapshot, setSnapshot] = useState<CacheSnapshot<T> | null>(
    initialSnapshot,
  );
  const [loading, setLoading] = useState(enabled && !initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  // A resource loader may hydrate a safe device snapshot into CacheService
  // before its authoritative request settles. Keep that loading lifecycle
  // intact: the cache event makes the safe snapshot renderable, but must not
  // make a pending request look terminal to the consuming surface.
  const refreshSequenceRef = useRef(0);
  const activeRefreshIdRef = useRef<number | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A request may settle after its hook has been re-keyed (most importantly,
  // after an account switch). Suppress every state write from that obsolete
  // request. The generation also covers A -> B -> A and enabled toggles, where
  // comparing only the cache-key string would accept an older session's work.
  const activeResourceRef = useRef({ cacheKey, enabled, generation: 0 });
  if (
    activeResourceRef.current.cacheKey !== cacheKey ||
    activeResourceRef.current.enabled !== enabled
  ) {
    activeResourceRef.current = {
      cacheKey,
      enabled,
      generation: activeResourceRef.current.generation + 1,
    };
  }
  const resourceGeneration = activeResourceRef.current.generation;

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    return cache.subscribe((event) => {
      if (
        activeResourceRef.current.cacheKey !== cacheKey ||
        activeResourceRef.current.generation !== resourceGeneration
      ) {
        return;
      }
      if (event.type === "set" && event.key === cacheKey) {
        const nextSnapshot = cache.peek<T>(cacheKey);
        dataRef.current = nextSnapshot?.data ?? null;
        setSnapshot(nextSnapshot);
        startTransition(() => {
          setData(nextSnapshot?.data ?? null);
        });
        if (activeRefreshIdRef.current === null) {
          setLoading(false);
          setRefreshing(false);
        }
        setInvalidated(false);
        // A fresh value landed in the cache (e.g. a background refresh that
        // resolved through another hook instance). Clear any stale error so the
        // UI doesn't keep showing "Failed to refresh" on top of good data.
        if (nextSnapshot?.data != null) {
          setError(null);
        }
        return;
      }

      if (
        event.type === "invalidate" &&
        event.keys.includes(cacheKey) &&
        retainOnInvalidate
      ) {
        // Some user-facing, memory-only read models (such as consent rows)
        // can safely stay visible during a mutation reconciliation. The cache
        // entry itself is gone, so the next forced refresh still fetches the
        // authoritative state; only the rendered stale snapshot is retained.
        setInvalidated(true);
        return;
      }

      if (
        (event.type === "invalidate" && event.keys.includes(cacheKey)) ||
        (event.type === "invalidate_user" && event.keys.includes(cacheKey)) ||
        event.type === "clear"
      ) {
        dataRef.current = null;
        setInvalidated(true);
        setSnapshot(null);
        startTransition(() => {
          setData(null);
        });
      }
    });
  }, [cache, cacheKey, resourceGeneration, retainOnInvalidate]);

  useEffect(() => {
    const nextSnapshot = cache.peek<T>(cacheKey);
    activeRefreshIdRef.current = null;
    dataRef.current = nextSnapshot?.data ?? null;
    setRenderedCacheKey(cacheKey);
    setSnapshot(nextSnapshot);
    startTransition(() => {
      setData(nextSnapshot?.data ?? null);
    });
    setLoading(enabled && !nextSnapshot);
    setRefreshing(false);
    setInvalidated(false);
    setError(null);
  }, [cache, cacheKey, enabled]);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      const isCurrentResource = () =>
        activeResourceRef.current.cacheKey === cacheKey &&
        activeResourceRef.current.enabled === enabled &&
        activeResourceRef.current.generation === resourceGeneration;
      if (!enabled || !isCurrentResource()) return null;

      const cachedSnapshot = cache.peek<T>(cacheKey);
      const hasRetainedData = dataRef.current !== null;
      if (cachedSnapshot) {
        logRequestAudit(
          label,
          cachedSnapshot.isFresh ? "cache_hit" : "stale_hit",
          {
            cacheKey,
          },
        );
        setSnapshot(cachedSnapshot);
        startTransition(() => {
          setData(cachedSnapshot.data);
        });
      } else {
        logRequestAudit(label, "cache_miss", {
          cacheKey,
        });
      }

      if (!options?.force && cachedSnapshot?.isFresh) {
        setLoading(false);
        setRefreshing(false);
        setError(null);
        setInvalidated(false);
        return cachedSnapshot.data;
      }

      const refreshId = ++refreshSequenceRef.current;
      activeRefreshIdRef.current = refreshId;

      const existingRequest = inflightRequests.get(cacheKey) as
        Promise<T> | undefined;
      if (existingRequest) {
        logRequestAudit(label, "inflight_dedupe_hit", {
          cacheKey,
          force: Boolean(options?.force),
        });
        if (cachedSnapshot || hasRetainedData) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        try {
          const sharedResult = await existingRequest;
          if (!isCurrentResource()) {
            return null;
          }
          const nextSnapshot = cache.peek<T>(cacheKey);
          setSnapshot(nextSnapshot);
          startTransition(() => {
            setData(nextSnapshot?.data ?? sharedResult ?? null);
          });
          setError(null);
          setInvalidated(false);
          return sharedResult ?? nextSnapshot?.data ?? null;
        } catch (loadError) {
          if (!isCurrentResource()) {
            return null;
          }
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load resource",
          );
          return cachedSnapshot?.data ?? null;
        } finally {
          if (isCurrentResource() && activeRefreshIdRef.current === refreshId) {
            activeRefreshIdRef.current = null;
            setLoading(false);
            setRefreshing(false);
          }
        }
      }

      if (cachedSnapshot || hasRetainedData) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        logRequestAudit(label, "network_fetch", {
          cacheKey,
          force: Boolean(options?.force),
        });
        const request = Promise.resolve(loadRef.current(options));
        inflightRequests.set(cacheKey, request);
        const next = await request;
        if (!isCurrentResource()) {
          return null;
        }
        const nextSnapshot = cache.peek<T>(cacheKey);
        dataRef.current = nextSnapshot?.data ?? next;
        setSnapshot(nextSnapshot);
        startTransition(() => {
          setData(nextSnapshot?.data ?? next);
        });
        setError(null);
        setInvalidated(false);
        return next;
      } catch (loadError) {
        if (!isCurrentResource()) {
          return null;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load resource",
        );
        return cachedSnapshot?.data ?? null;
      } finally {
        if (isCurrentResource() && activeRefreshIdRef.current === refreshId) {
          activeRefreshIdRef.current = null;
          setLoading(false);
          setRefreshing(false);
        }
        const existing = inflightRequests.get(cacheKey);
        if (existing) {
          inflightRequests.delete(cacheKey);
        }
      }
    },
    [cache, cacheKey, enabled, label, resourceGeneration],
  );

  // Keep the latest refresh in a ref so the auto-load effect below can run it
  // without listing `refresh` in its dependency array. `refresh` changes
  // identity whenever cacheKey/label change, and including it would re-fire the
  // load on every benign re-key (e.g. URL-normalization churn) even when the
  // cached value is still fresh. The effect is intentionally keyed only on the
  // semantic inputs: enabled, cacheKey, and refreshKey.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refreshRef.current();
  }, [enabled, cacheKey, refreshKey]);

  const stateMatchesCacheKey = renderedCacheKey === cacheKey;

  return {
    data: stateMatchesCacheKey ? data : (initialSnapshot?.data ?? null),
    snapshot: stateMatchesCacheKey ? snapshot : initialSnapshot,
    loading: stateMatchesCacheKey ? loading : enabled && !initialSnapshot,
    refreshing: stateMatchesCacheKey ? refreshing : false,
    invalidated: stateMatchesCacheKey ? invalidated : false,
    error: stateMatchesCacheKey ? error : null,
    refresh,
  };
}
