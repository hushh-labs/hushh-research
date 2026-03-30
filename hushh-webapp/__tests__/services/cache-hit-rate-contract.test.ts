import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";

describe("CacheService hit-rate contract", () => {
  let cache: CacheService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:00:00.000Z"));
    cache = CacheService.getInstance();
    cache.clear();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  // ---------- 1. Fresh entry via peek ----------
  it("set + peek returns isFresh: true and isStale: false within TTL", () => {
    cache.set("test_key", { value: 42 }, CACHE_TTL.MEDIUM);

    const snapshot = cache.peek<{ value: number }>("test_key");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.isFresh).toBe(true);
    expect(snapshot!.isStale).toBe(false);
    expect(snapshot!.data).toEqual({ value: 42 });
  });

  // ---------- 2. Stale entry via peek after TTL ----------
  it("peek returns isStale: true and isFresh: false after TTL expires (data still present)", () => {
    cache.set("test_key", { value: 42 }, CACHE_TTL.MEDIUM);

    vi.advanceTimersByTime(CACHE_TTL.MEDIUM + 1);

    const snapshot = cache.peek<{ value: number }>("test_key");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.isStale).toBe(true);
    expect(snapshot!.isFresh).toBe(false);
    expect(snapshot!.data).toEqual({ value: 42 });
  });

  // ---------- 3. get auto-deletes stale entries ----------
  it("get returns null after expiry and auto-deletes the stale entry", () => {
    cache.set("test_key", { value: 42 }, CACHE_TTL.MEDIUM);

    vi.advanceTimersByTime(CACHE_TTL.MEDIUM + 1);

    expect(cache.get("test_key")).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });

  // ---------- 4. invalidatePattern removes matching keys and emits ----------
  it("invalidatePattern removes all matching keys and emits invalidate event with affected keys", () => {
    const events: Array<{ type: string; keys?: string[] }> = [];
    cache.subscribe((event) => {
      if (event.type === "invalidate") {
        events.push(event);
      }
    });

    cache.set("prefix_alpha", "a", CACHE_TTL.SHORT);
    cache.set("prefix_beta", "b", CACHE_TTL.SHORT);
    cache.set("other_gamma", "c", CACHE_TTL.SHORT);

    cache.invalidatePattern("prefix_");

    expect(cache.get("prefix_alpha")).toBeNull();
    expect(cache.get("prefix_beta")).toBeNull();
    expect(cache.get("other_gamma")).toBe("c");

    const patternEvent = events.find(
      (e) => e.type === "invalidate" && e.keys && e.keys.length === 2
    );
    expect(patternEvent).toBeDefined();
    expect(patternEvent!.keys!.sort()).toEqual(["prefix_alpha", "prefix_beta"]);
  });

  // ---------- 5. invalidateUser removes 22+ fixed keys and prefix patterns ----------
  it("invalidateUser removes fixed user-scoped keys and pattern-matched dynamic keys, emits invalidate_user", () => {
    const userId = "u-abc";
    const events: Array<{ type: string; userId?: string; keys?: string[] }> = [];
    cache.subscribe((event) => {
      if (event.type === "invalidate_user") {
        events.push(event as any);
      }
    });

    // Seed fixed keys
    cache.set(CACHE_KEYS.PKM_METADATA(userId), 1, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PKM_BLOB(userId), 2, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId), 3, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.VAULT_STATUS(userId), 4, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.VAULT_CHECK(userId), 5, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId), 6, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.ACTIVE_CONSENTS(userId), 7, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PENDING_CONSENTS(userId), 8, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.CONSENT_AUDIT_LOG(userId), 9, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.CONSENT_CENTER(userId, "all"), 10, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "investor"), 11, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "ria"), 12, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PORTFOLIO_DATA(userId), 13, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.KAI_FINANCIAL_RESOURCE(userId), 14, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.DEVELOPER_ACCESS(userId), 15, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PKM_UPGRADE_STATUS(userId), 16, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.KAI_PROFILE(userId), 17, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.ANALYSIS_HISTORY(userId), 18, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.PERSONA_STATE(userId), 19, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId), 20, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.RIA_ROSTER_SUMMARY(userId), 21, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.RIA_HOME(userId), 22, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.RIA_PICKS(userId), 23, CACHE_TTL.SHORT);

    // Seed dynamic prefix keys
    cache.set(`domain_data_${userId}_health`, "d1", CACHE_TTL.SHORT);
    cache.set(`stock_context_${userId}_AAPL`, "d2", CACHE_TTL.SHORT);
    cache.set(`kai_market_home_${userId}_spy_30_default`, "d3", CACHE_TTL.SHORT);

    // Unrelated key should survive
    cache.set("unrelated_key", "safe", CACHE_TTL.SHORT);

    cache.invalidateUser(userId);

    expect(cache.get("unrelated_key")).toBe("safe");
    expect(cache.get(CACHE_KEYS.PKM_METADATA(userId))).toBeNull();
    expect(cache.get(CACHE_KEYS.RIA_PICKS(userId))).toBeNull();
    expect(cache.get(`domain_data_${userId}_health`)).toBeNull();
    expect(cache.get(`stock_context_${userId}_AAPL`)).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("invalidate_user");
    expect(events[0].userId).toBe(userId);
    expect(events[0].keys!.length).toBeGreaterThanOrEqual(22);
  });

  // ---------- 6. subscribe receives set/invalidate/clear events ----------
  it("subscribe listener receives set, invalidate, and clear events in order", () => {
    const events: Array<{ type: string }> = [];
    cache.subscribe((event) => events.push(event));

    cache.set("k1", "v1", CACHE_TTL.SHORT);
    cache.invalidate("k1");
    cache.set("k2", "v2", CACHE_TTL.SHORT);
    cache.clear();

    expect(events.map((e) => e.type)).toEqual(["set", "invalidate", "set", "clear"]);
  });

  // ---------- 7. clear removes all entries and emits clear event ----------
  it("clear removes all entries and emits clear event", () => {
    const events: Array<{ type: string }> = [];
    cache.subscribe((event) => events.push(event));

    cache.set("a", 1, CACHE_TTL.SHORT);
    cache.set("b", 2, CACHE_TTL.SHORT);
    expect(cache.getStats().size).toBe(2);

    cache.clear();

    expect(cache.getStats().size).toBe(0);
    const clearEvents = events.filter((e) => e.type === "clear");
    expect(clearEvents).toHaveLength(1);
  });

  // ---------- 8. invalidateMany batch deletes and emits ----------
  it("invalidateMany batch deletes multiple keys and emits a single invalidate event", () => {
    const events: Array<{ type: string; keys?: string[] }> = [];
    cache.subscribe((event) => {
      if (event.type === "invalidate") {
        events.push(event as any);
      }
    });

    cache.set("x1", 1, CACHE_TTL.SHORT);
    cache.set("x2", 2, CACHE_TTL.SHORT);
    cache.set("x3", 3, CACHE_TTL.SHORT);

    cache.invalidateMany(["x1", "x3"]);

    expect(cache.get("x1")).toBeNull();
    expect(cache.get("x2")).toBe(2);
    expect(cache.get("x3")).toBeNull();

    // invalidateMany should emit exactly one invalidate event for the batch
    const batchEvent = events.find(
      (e) => e.type === "invalidate" && e.keys && e.keys.length === 2
    );
    expect(batchEvent).toBeDefined();
    expect(batchEvent!.keys!.sort()).toEqual(["x1", "x3"]);
  });

  // ---------- 9. Unsubscribe stops receiving events ----------
  it("unsubscribe stops the listener from receiving further events", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = cache.subscribe((event) => events.push(event));

    cache.set("before", 1, CACHE_TTL.SHORT);
    expect(events).toHaveLength(1);

    unsubscribe();

    cache.set("after", 2, CACHE_TTL.SHORT);
    cache.clear();

    // No new events after unsubscribe
    expect(events).toHaveLength(1);
  });
});
