import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: { uid: "owner" } as { uid: string } | null, list: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => mocks.owner } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { listTrustedDevices: mocks.list, revokeTrustedDevice: mocks.revoke } }));
vi.mock("@/lib/cache/cache-sync-service", async () => {
  const { CacheService, CACHE_KEYS } = await import("@/lib/services/cache-service");
  return { CacheSyncService: { onTrustedDevicesMutated: (id: string) => CacheService.getInstance().invalidate(CACHE_KEYS.TRUSTED_DEVICES(id)) } };
});
import { TrustedDevicesResourceService as Resource } from "@/lib/services/trusted-devices-resource-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
const cache = CacheService.getInstance();
const key = CACHE_KEYS.TRUSTED_DEVICES("owner");
beforeEach(() => { cache.clear(); mocks.owner = { uid: "owner" }; vi.clearAllMocks(); });
it("keeps a confirmed empty list warm across navigation", async () => {
  mocks.list.mockResolvedValue(new Response(JSON.stringify({ devices: [] })));
  const load = () => Resource.load("owner");
  const first = renderHook(() => useStaleResource({ cacheKey: key, load }));
  await waitFor(() => expect(first.result.current.data).toEqual([]));
  first.unmount();
  const second = renderHook(() => useStaleResource({ cacheKey: key, load }));
  expect(second.result.current.data).toEqual([]);
  expect(second.result.current.loading).toBe(false);
});
it.each(["owner", "epoch", "revocation"])("refuses a stale response after %s changes", async boundary => {
  let resolve!: (response: Response) => void;
  mocks.list.mockReturnValue(new Promise<Response>(r => { resolve = r; }));
  const request = Resource.load("owner");
  if (boundary === "owner") mocks.owner = { uid: "other" };
  if (boundary === "epoch") advanceVaultSessionEpoch();
  if (boundary === "revocation") {
    mocks.revoke.mockResolvedValue(new Response(null, { status: 204 }));
    await Resource.revoke("owner", "synthetic-device");
  }
  resolve(new Response(JSON.stringify({ devices: [] })));
  await expect(request).rejects.toThrow("Device status changed");
  expect(cache.peek(key)).toBeNull();
});
it("clears owner metadata on revocation and account invalidation", async () => {
  cache.set(key, []);
  mocks.revoke.mockResolvedValue(new Response(null, { status: 204 }));
  await Resource.revoke("owner", "synthetic-device");
  expect(cache.peek(key)).toBeNull();
  cache.set(key, []);
  cache.invalidateUser("owner");
  expect(cache.peek(key)).toBeNull();
});
