import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";

import {
  ConsentCacheManager,
  verifyLocalConsentActionAccess,
} from "../../lib/consent/consent-cache-manager";

describe("ConsentCacheManager", () => {
  it("executes and stores the fallback result on a clean cache miss", async () => {
    const manager = new ConsentCacheManager();
    const fetchRemoteFallback = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const result = await manager.verifyConsent("user-1", fetchRemoteFallback);

    expect(result).toBe(true);
    expect(fetchRemoteFallback).toHaveBeenCalledTimes(1);
  });

  it("returns a subsequent cache hit without calling the fallback a second time", async () => {
    const manager = new ConsentCacheManager();
    const fetchRemoteFallback = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const firstResult = await manager.verifyConsent("user-2", fetchRemoteFallback);
    const secondResult = await manager.verifyConsent("user-2", fetchRemoteFallback);

    expect(firstResult).toBe(false);
    expect(secondResult).toBe(false);
    expect(fetchRemoteFallback).toHaveBeenCalledTimes(1);
  });

  it("fails closed for sudden empty user strings without using the fallback", async () => {
    const manager = new ConsentCacheManager();
    const fetchRemoteFallback = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const emptyResult = await manager.verifyConsent("", fetchRemoteFallback);
    const whitespaceResult = await manager.verifyConsent("   ", fetchRemoteFallback);

    expect(emptyResult).toBe(false);
    expect(whitespaceResult).toBe(false);
    expect(fetchRemoteFallback).not.toHaveBeenCalled();
  });

  it("resolves cache hits in under 2ms", async () => {
    const manager = new ConsentCacheManager();
    const fetchRemoteFallback = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    await manager.verifyConsent("user-fast", fetchRemoteFallback);

    const startTime = performance.now();
    const result = await manager.verifyConsent("user-fast", fetchRemoteFallback);
    const durationMs = performance.now() - startTime;

    expect(result).toBe(true);
    expect(fetchRemoteFallback).toHaveBeenCalledTimes(1);
    expect(durationMs).toBeLessThan(2);
  });

  it("fails closed for local consent action access when the current token is empty", async () => {
    const primedResult = await verifyLocalConsentActionAccess(
      "user-action",
      "vault-owner-token",
    );
    const emptyTokenResult = await verifyLocalConsentActionAccess("user-action", "");

    expect(primedResult).toBe(true);
    expect(emptyTokenResult).toBe(false);
  });
});
