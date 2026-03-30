"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CacheService, type CacheSnapshot } from "@/lib/services/cache-service";

const inflightRequests = new Map<string, Promise<unknown>>();

type UseStaleResourceOptions<T> = {
  cacheKey: string;
  enabled?: boolean;
  load: (options?: { force?: boolean }) => Promise<T>;
  resourceLabel?: string;
  refreshKey?: string;
};

type UseStaleResourceResult<T> = {
  data: T | null;
  snapshot: CacheSnapshot<T> | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<T | null>;
};

export function useStaleResource<T>({
  cacheKey,
  enabled = true,
  load,
  resourceLabel,
  refreshKey = "",
}: UseStaleResourceOptions<T>): UseStaleResourceResult<T> {
  const cache = useMemo(() => CacheService.getInstance(), []);
  const loadRef = useRef(load);
  const label = resourceLabel ? `${resourceLabel}:hook` : cacheKey;
  const initialSnapshot = useMemo(() => cache.peek<T>(cacheKey), [cache, cacheKey]);
  const [data, setData] = useState<T | null>(initialSnapshot?.data ?? null);
  const [snapshot, setSnapshot] = useState<CacheSnapshot<T> | null>(initialSnapshot);
  const [loading, setLoading] = useState(enabled && !initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    return cache.subscribe((event) => {
      if (event.type === "set" && event.key === cacheKey) {
        const nextSnapshot = cache.peek<T>(cacheKey);
        setSnapshot(nextSnapshot);
        startTransition(() => {
          setData(nextSnapshot?.data ?? null);
        });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (
        (event.type === "invalidate" && event.keys.includes(cacheKey)) ||
        (event.type === "invalidate_user" && event.keys.includes(cacheKey)) ||
        event.type === "clear"
      ) {
        setSnapshot(null);
        startTransition(() => {
          setData(null);
        });
      }
    });
  }, [cache, cacheKey]);

  useEffect(() => {
    const nextSnapshot = cache.peek<T>(cacheKey);
    setSnapshot(nextSnapshot);
    startTransition(() => {
      setData(nextSnapshot?.data ?? null);
    });
    setLoading(enabled && !nextSnapshot);
    setRefreshing(false);
    setError(null);
  }, [cache, cacheKey, enabled]);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!enabled) return null;

      const cachedSnapshot = cache.peek<T>(cacheKey);
      if (cachedSnapshot) {
        console.info(`[RequestAudit:${label}] ${cachedSnapshot.isFresh ? "cache_hit" : "stale_hit"}`, {
          cacheKey,
        });
        setSnapshot(cachedSnapshot);
        startTransition(() => {
          setData(cachedSnapshot.data);
        });
      } else {
        console.info(`[RequestAudit:${label}] cache_miss`, {
          cacheKey,
        });
      }

      if (!options?.force && cachedSnapshot?.isFresh) {
        setLoading(false);
        setRefreshing(false);
        setError(null);
        return cachedSnapshot.data;
      }

      const existingRequest = inflightRequests.get(cacheKey) as Promise<T> | undefined;
      if (existingRequest) {
        console.info(`[RequestAudit:${label}] inflight_dedupe_hit`, {
          cacheKey,
          force: Boolean(options?.force),
        });
        if (cachedSnapshot) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        try {
          const sharedResult = await existingRequest;
          const nextSnapshot = cache.peek<T>(cacheKey);
          setSnapshot(nextSnapshot);
          startTransition(() => {
            setData(nextSnapshot?.data ?? sharedResult ?? null);
          });
          setError(null);
          return sharedResult ?? nextSnapshot?.data ?? null;
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load resource");
          return cachedSnapshot?.data ?? null;
        } finally {
          setLoading(false);
          setRefreshing(false);
        }
      }

      if (cachedSnapshot) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        console.info(`[RequestAudit:${label}] network_fetch`, {
          cacheKey,
          force: Boolean(options?.force),
        });
        const request = Promise.resolve(loadRef.current(options));
        inflightRequests.set(cacheKey, request);
        const next = await request;
        const nextSnapshot = cache.peek<T>(cacheKey);
        setSnapshot(nextSnapshot);
        startTransition(() => {
          setData(nextSnapshot?.data ?? next);
        });
        setError(null);
        return next;
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load resource");
        return cachedSnapshot?.data ?? null;
      } finally {
        const existing = inflightRequests.get(cacheKey);
        if (existing) {
          inflightRequests.delete(cacheKey);
        }
        setLoading(false);
        setRefreshing(false);
      }
    },
    [cache, cacheKey, enabled, label]
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh, refreshKey]);

  return {
    data,
    snapshot,
    loading,
    refreshing,
    error,
    refresh,
  };
}
