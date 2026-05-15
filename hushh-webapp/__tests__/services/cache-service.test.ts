import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheService } from "@/lib/services/cache-service";

describe("CacheService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T12:00:00.000Z"));
    CacheService.getInstance().clear();
  });

  afterEach(() => {
    CacheService.getInstance().clear();
    vi.useRealTimers();
  });

  it("reports fresh and stale cache snapshots without immediately evicting stale data", () => {
    const cache = CacheService.getInstance();

    cache.set("market-home", { ok: true }, 1_000);

    expect(cache.peek<{ ok: boolean }>("market-home")).toMatchObject({
      data: { ok: true },
      isFresh: true,
      isStale: false,
      ttl: 1_000,
    });

    vi.advanceTimersByTime(1_250);

    const staleSnapshot = cache.peek<{ ok: boolean }>("market-home");
    expect(staleSnapshot).toMatchObject({
      data: { ok: true },
      isFresh: false,
      isStale: true,
      ttl: 1_000,
    });
    expect(cache.getStats().size).toBe(1);
  });

  it("evicts stale data on direct reads", () => {
    const cache = CacheService.getInstance();

    cache.set("market-home", { ok: true }, 1_000);
    vi.advanceTimersByTime(1_250);

    expect(cache.get("market-home")).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });
  it("stabilizes stale snapshot expiry boundaries after ttl elapses", () => {
  const cache = CacheService.getInstance();

  cache.set("consent-center", { synced: true }, 1_000);

  expect(cache.peek<{ synced: boolean }>("consent-center")).toMatchObject({
    isFresh: true,
    isStale: false,
  });

  vi.advanceTimersByTime(999);

  expect(cache.peek<{ synced: boolean }>("consent-center")).toMatchObject({
    isFresh: true,
    isStale: false,
  });

  vi.advanceTimersByTime(2);

  expect(cache.peek<{ synced: boolean }>("consent-center")).toMatchObject({
    isFresh: false,
    isStale: true,
  });

  expect(cache.getStats().size).toBe(1);
});
});
