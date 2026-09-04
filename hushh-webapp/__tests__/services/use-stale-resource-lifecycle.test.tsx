import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CacheService } from "@/lib/services/cache-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCache() {
  return CacheService.getInstance();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useStaleResource lifecycle", () => {
  beforeEach(() => {
    getCache().clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    getCache().clear();
  });

  // 1 – Cold start: initially loading=true, after load resolves -> data populated, loading=false
  it("starts with loading=true on cold cache, resolves to data + loading=false", async () => {
    const payload = { items: [1, 2, 3] };
    let resolveLoad!: (value: typeof payload) => void;
    const load = vi.fn(
      () =>
        new Promise<typeof payload>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "cold-key",
        enabled: true,
        load,
      }),
    );

    // Before the promise resolves, the hook should be loading
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    // Resolve the load and write to cache (as the real loader would)
    await act(async () => {
      getCache().set("cold-key", payload);
      resolveLoad(payload);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(payload);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps loading while a loader hydrates cache before its authority settles", async () => {
    const hydrated = { source: "device" };
    const authoritative = { source: "network" };
    let resolveLoad!: (value: typeof authoritative) => void;
    const load = vi.fn(
      () =>
        new Promise<typeof authoritative>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "hydrating-key",
        enabled: true,
        load,
      }),
    );

    expect(result.current.loading).toBe(true);
    await act(async () => {
      getCache().set("hydrating-key", hydrated);
    });

    expect(result.current.data).toEqual(hydrated);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      getCache().set("hydrating-key", authoritative);
      resolveLoad(authoritative);
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(authoritative);
  });

  // 2 – Warm cache: data available immediately without loading phase
  it("returns cached data immediately on warm cache", async () => {
    const payload = { cached: true };
    getCache().set("warm-key", payload);

    const load = vi.fn(async () => payload);

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "warm-key",
        enabled: true,
        load,
      }),
    );

    // Data available immediately from cache snapshot – no loading
    expect(result.current.data).toEqual(payload);
    expect(result.current.loading).toBe(false);
  });

  // 3 – Default cache invalidation clears the rendered value.
  it("clears data after cache.invalidate(key) by default", async () => {
    const initial = { version: 1 };
    const updated = { version: 2 };
    let callCount = 0;

    const load = vi.fn(async () => {
      callCount++;
      const data = callCount === 1 ? initial : updated;
      getCache().set("inv-key", data);
      return data;
    });

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "inv-key",
        enabled: true,
        load,
      }),
    );

    // Wait for initial load
    await waitFor(() => {
      expect(result.current.data).toEqual(initial);
    });

    // Invalidate the cache entry – the hook subscribes to CacheService events
    // and should clear data, triggering a state change.
    act(() => {
      getCache().invalidate("inv-key");
    });

    // After invalidation the data should be cleared
    await waitFor(() => {
      expect(result.current.data).toBeNull();
    });
  });

  it("keeps an opted-in stale value visible while a mutation refreshes it", async () => {
    const initial = { version: 1 };
    getCache().set("retained-key", initial);
    let resolveLoad!: (value: typeof initial) => void;

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "retained-key",
        enabled: true,
        retainOnInvalidate: true,
        load: vi.fn(
          () =>
            new Promise<typeof initial>((resolve) => {
              resolveLoad = resolve;
            }),
        ),
      }),
    );

    expect(result.current.data).toEqual(initial);
    act(() => {
      getCache().invalidate("retained-key");
    });
    void result.current.refresh({ force: true });

    await waitFor(() => {
      expect(result.current.refreshing).toBe(true);
    });
    expect(result.current.data).toEqual(initial);
    await act(async () => {
      resolveLoad(initial);
    });
  });

  // 4 – Dedup: two hooks with same cacheKey result in load called only once
  it("deduplicates concurrent loads for the same cacheKey", async () => {
    let resolveLoad!: (value: string) => void;
    const slowLoad = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const makeProps = () => ({
      cacheKey: "dedup-key",
      enabled: true,
      load: slowLoad,
    });

    // Render two hooks concurrently with the same key
    const hook1 = renderHook(() => useStaleResource(makeProps()));
    const hook2 = renderHook(() => useStaleResource(makeProps()));

    // Both should be loading
    expect(hook1.result.current.loading).toBe(true);
    expect(hook2.result.current.loading).toBe(true);

    // Resolve the single inflight promise
    await act(async () => {
      getCache().set("dedup-key", "shared-result");
      resolveLoad("shared-result");
    });

    await waitFor(() => {
      expect(hook1.result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(hook2.result.current.loading).toBe(false);
    });

    // load should have been invoked at most once thanks to inflight dedup
    expect(slowLoad).toHaveBeenCalledTimes(1);
  });

  // 5 – Error recovery: failed load sets error, preserves stale data if available
  it("sets error on failed load and preserves stale data when available", async () => {
    const staleData = { stale: true };
    // Set with a 1ms TTL so it becomes stale almost immediately,
    // forcing the hook to call load even though data is cached.
    getCache().set("err-key", staleData, 1);

    // Small delay to ensure the entry is stale by the time the hook reads it
    await new Promise((r) => setTimeout(r, 5));

    const failingLoad = vi.fn(async () => {
      throw new Error("Network failure");
    });

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "err-key",
        enabled: true,
        load: failingLoad,
      }),
    );

    // Initially the hook should pick up cached (stale) data via peek
    expect(result.current.data).toEqual(staleData);

    await waitFor(() => {
      expect(result.current.error).toBe("Network failure");
    });

    // Stale data should be preserved even after error
    expect(result.current.data).toEqual(staleData);
    expect(result.current.loading).toBe(false);
  });

  // 6 – enabled=false prevents fetching
  it("does not fetch when enabled=false", async () => {
    const load = vi.fn(async () => "should-not-load");

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "disabled-key",
        enabled: false,
        load,
      }),
    );

    // Give it a tick to ensure nothing fires
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(load).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  // 7 – Stuck-error regression: after a failed load sets error, a fresh value
  //     landing in the cache (e.g. a background refresh resolving through
  //     another hook instance) must CLEAR the error. This is the root cause of
  //     the iOS "Failed to refresh market home" banner showing on top of loaded
  //     data — the error state was never cleared on a cache-driven success.
  it("clears a stale error when a fresh value lands via the cache subscription", async () => {
    const staleData = { stale: true };
    getCache().set("recover-key", staleData, 1);
    await new Promise((r) => setTimeout(r, 5));

    const failingLoad = vi.fn(async () => {
      throw new Error("Network failure");
    });

    const { result } = renderHook(() =>
      useStaleResource({
        cacheKey: "recover-key",
        enabled: true,
        load: failingLoad,
      }),
    );

    // Error is set by the failed load.
    await waitFor(() => {
      expect(result.current.error).toBe("Network failure");
    });

    // A background refresh (another instance) writes a fresh value to the cache.
    await act(async () => {
      getCache().set("recover-key", { recovered: true });
    });

    // The error must be cleared now that good data is present.
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
    expect(result.current.data).toEqual({ recovered: true });
  });

  it("never lets a late response from a previous cache key overwrite the active resource", async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const load = vi.fn(
      (cacheKey: string) =>
        new Promise<string>((resolve) => {
          if (cacheKey === "feed:user-a") resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ cacheKey }) =>
        useStaleResource({
          cacheKey,
          enabled: true,
          load: () => load(cacheKey),
        }),
      { initialProps: { cacheKey: "feed:user-a" } },
    );

    await waitFor(() => expect(load).toHaveBeenCalledWith("feed:user-a"));

    rerender({ cacheKey: "feed:user-b" });

    // The previous user's value is never exposed while the new request starts.
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(load).toHaveBeenCalledWith("feed:user-b"));

    await act(async () => {
      getCache().set("feed:user-b", "user-b-data");
      resolveSecond("user-b-data");
    });
    await waitFor(() => expect(result.current.data).toBe("user-b-data"));

    // The first request settles last. It may still populate its own keyed cache,
    // but it must not mutate the active hook state or its loading lifecycle.
    await act(async () => {
      getCache().set("feed:user-a", "user-a-data");
      resolveFirst("user-a-data");
    });

    expect(result.current.data).toBe("user-b-data");
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
