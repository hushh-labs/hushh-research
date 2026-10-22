import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const peekCachedDomainBlobMock = vi.fn();
const loadDomainDataWithBlobMock = vi.fn();
const loadDomainSnapshotMock = vi.fn();
const secureReadMock = vi.fn();
const secureWriteMock = vi.fn();
const secureInvalidateMock = vi.fn();

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    peekCachedDomainBlob: (...args: unknown[]) => peekCachedDomainBlobMock(...args),
    loadDomainDataWithBlob: (...args: unknown[]) => loadDomainDataWithBlobMock(...args),
    loadDomainSnapshot: (...args: unknown[]) => loadDomainSnapshotMock(...args),
  },
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: (...args: unknown[]) => secureReadMock(...args),
    write: (...args: unknown[]) => secureWriteMock(...args),
    invalidateResourcePrefix: (...args: unknown[]) => secureInvalidateMock(...args),
  },
}));

import { PkmDomainResourceService, usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";

describe("PkmDomainResourceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
  });

  it.each(["memory", "device"])("contains a failed background refresh for a warm %s snapshot", async tier => {
    const snapshot = { key: { userId: "warm-owner", domain: "one_memory", segmentIds: [], contentRevision: 1 }, data: { markdown: "kept" }, manifestRevision: null, updatedAt: null, audit: { cacheTier: "device", source: "secure_cache", refreshedAt: "now" } };
    peekCachedDomainBlobMock.mockReturnValue(null);
    secureReadMock.mockResolvedValue(tier === "device" ? snapshot : null);
    const peek = vi.spyOn(CacheService.getInstance(), "peek").mockReturnValue(tier === "memory" ? { data: snapshot, isFresh: false } : null);
    loadDomainDataWithBlobMock.mockRejectedValueOnce(new Error("Synthetic background failure"));
    try {
      await expect(PkmDomainResourceService.getStaleFirst({ userId: "warm-owner", domain: "one_memory", vaultKey: "vault-key", vaultOwnerToken: "vault-owner" })).resolves.toMatchObject({ data: { markdown: "kept" } });
      expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { peek.mockRestore(); }
  });

  it("forwards an explicit refresh past the identity cache after a Settings save", async () => {
    const read = vi.spyOn(PkmDomainResourceService, "getStaleFirst").mockResolvedValue(null);
    try {
      const hook = renderHook(() => usePkmDomainResource({ userId: "owner-force", domain: "identity", vaultKey: "key", vaultOwnerToken: "token" }));
      await waitFor(() => expect(read).toHaveBeenCalled());
      await act(async () => { await hook.result.current.refresh({ force: true }); });
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "owner-force", domain: "identity", forceRefresh: true }));
      hook.unmount();
    } finally { read.mockRestore(); }
  });

  it("does not return a stale secure-cache domain when the encrypted blob revision is newer", async () => {
    const userId = "user-financial";
    const oldDomain = {
      portfolio: {
        holdings: [{ symbol: "OLD" }],
      },
    };
    const newDomain = {
      portfolio: {
        holdings: [{ symbol: "NEW" }],
      },
    };

    peekCachedDomainBlobMock.mockReturnValue({
      dataVersion: 2,
      updatedAt: "2026-05-18T05:55:00.000Z",
    });
    secureReadMock.mockResolvedValue({
      key: {
        userId,
        domain: "financial",
        segmentIds: [],
        contentRevision: 1,
      },
      data: oldDomain,
      manifestRevision: null,
      updatedAt: "2026-05-17T05:55:00.000Z",
      audit: {
        cacheTier: "device",
        source: "secure_cache",
        refreshedAt: "2026-05-17T05:55:00.000Z",
      },
    });
    loadDomainDataWithBlobMock.mockResolvedValue({
      data: newDomain,
      blob: {
        dataVersion: 2,
        updatedAt: "2026-05-18T05:55:00.000Z",
      },
    });

    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId,
      domain: "financial",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      backgroundRefresh: false,
    });

    expect(snapshot?.data).toEqual(newDomain);
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(1);
    expect(secureWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        resourceKey: "pkm_domain:financial:all",
        value: expect.objectContaining({
          data: newDomain,
          key: expect.objectContaining({ contentRevision: 2 }),
        }),
      })
    );
  });

  it("does not return a fresh in-memory domain when the encrypted blob revision is newer", async () => {
    const userId = "user-financial";
    const oldDomain = {
      portfolio: {
        holdings: [{ symbol: "OLD" }],
      },
    };
    const newDomain = {
      portfolio: {
        holdings: [{ symbol: "NEW" }],
      },
    };

    peekCachedDomainBlobMock.mockReturnValue({
      dataVersion: 2,
      updatedAt: "2026-05-18T05:55:00.000Z",
    });
    CacheService.getInstance().set(
      CACHE_KEYS.PKM_DOMAIN_RESOURCE(userId, "financial", "all"),
      {
        key: {
          userId,
          domain: "financial",
          segmentIds: [],
          contentRevision: 1,
        },
        data: oldDomain,
        manifestRevision: null,
        updatedAt: "2026-05-17T05:55:00.000Z",
        audit: {
          cacheTier: "memory",
          source: "cache",
          refreshedAt: "2026-05-17T05:55:00.000Z",
        },
      },
      CACHE_TTL.SESSION,
    );
    loadDomainDataWithBlobMock.mockResolvedValue({
      data: newDomain,
      blob: {
        dataVersion: 2,
        updatedAt: "2026-05-18T05:55:00.000Z",
      },
    });

    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId,
      domain: "financial",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      backgroundRefresh: false,
    });

    expect(snapshot?.data).toEqual(newDomain);
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when a domain event arrives during an older network read", async () => {
    const staleDomain = { savedLocations: [{ id: "old" }] };
    const freshDomain = { savedLocations: [{ id: "fresh" }] };
    let resolveStale!: (value: unknown) => void;
    loadDomainDataWithBlobMock
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveStale = resolve;
        }),
      )
      .mockResolvedValueOnce({
        data: freshDomain,
        blob: { dataVersion: 2, updatedAt: "2026-09-20T00:00:01.000Z" },
      });

    const first = PkmDomainResourceService.refresh({
      userId: "location-owner",
      domain: "location",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });
    PkmDomainResourceService.invalidateDomain("location-owner", "location", {
      includeBackingCaches: true,
    });
    const second = PkmDomainResourceService.refresh({
      userId: "location-owner",
      domain: "location",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });
    resolveStale({
      data: staleDomain,
      blob: { dataVersion: 1, updatedAt: "2026-09-20T00:00:00.000Z" },
    });

    await expect(first).resolves.toEqual(expect.objectContaining({ data: freshDomain }));
    await expect(second).resolves.toEqual(expect.objectContaining({ data: freshDomain }));
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(2);
    expect(
      PkmDomainResourceService.peek({
        userId: "location-owner",
        domain: "location",
      })?.data.data,
    ).toEqual(freshDomain);
  });

  it("re-fetches when a domain event arrives during a secure-cache write", async () => {
    let resolveWrite!: () => void;
    secureWriteMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    secureInvalidateMock.mockResolvedValue(undefined);
    loadDomainDataWithBlobMock
      .mockResolvedValueOnce({
        data: { savedLocations: [{ id: "old" }] },
        blob: { dataVersion: 1, updatedAt: "2026-09-20T00:00:00.000Z" },
      })
      .mockResolvedValueOnce({
        data: { savedLocations: [{ id: "fresh" }] },
        blob: { dataVersion: 2, updatedAt: "2026-09-20T00:00:01.000Z" },
      });

    const first = PkmDomainResourceService.refresh({
      userId: "write-race-owner",
      domain: "location",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });
    await vi.waitFor(() => expect(secureWriteMock).toHaveBeenCalledOnce());
    PkmDomainResourceService.invalidateDomain("write-race-owner", "location", {
      includeDevice: true,
      includeBackingCaches: true,
    });
    const second = PkmDomainResourceService.refresh({
      userId: "write-race-owner",
      domain: "location",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });
    resolveWrite();

    await expect(first).resolves.toEqual(
      expect.objectContaining({ data: { savedLocations: [{ id: "fresh" }] } }),
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({ data: { savedLocations: [{ id: "fresh" }] } }),
    );
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(2);
    expect(secureInvalidateMock).toHaveBeenCalledWith(
      "write-race-owner",
      "pkm_domain:location:",
    );
  });

  // A domain under continuous write pressure (another failed writer retrying
  // the same domain, or one that will keep 404ing because it was never
  // created) used to recurse here with no cap and no backoff: one page load
  // produced well over a hundred identical network fetches in production.
  it.each(["read", "write"])("fails closed after bounded retries when invalidated during %s", async (phase) => {
    const userId = `storm-owner-${phase}`;
    const invalidate = () => PkmDomainResourceService.invalidateDomain(userId, "storm-domain", {
      includeBackingCaches: true,
    });
    secureWriteMock.mockImplementation(async () => {
      if (phase === "write") invalidate();
    });
    secureInvalidateMock.mockResolvedValue(undefined);
    loadDomainDataWithBlobMock.mockImplementation(async () => {
      // Every response arrives after the domain was invalidated again, so
      // the revision check never lands -- the storm this regression guards.
      if (phase === "read") invalidate();
      return {
        data: { value: "churned" },
        blob: { dataVersion: 1, updatedAt: "2026-09-20T00:00:00.000Z" },
      };
    });

    await expect(PkmDomainResourceService.refresh({
      userId,
      domain: "storm-domain",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    })).rejects.toThrow("Memory changed repeatedly while loading. Try again.");
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(4);
    secureWriteMock.mockReset();
  });

  it("returns absence only for a stable successful missing-domain read", async () => {
    loadDomainDataWithBlobMock.mockResolvedValue({ data: null, blob: null });
    await expect(PkmDomainResourceService.refresh({
      userId: "absent-owner",
      domain: "one_memory",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    })).resolves.toBeNull();
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce();
    expect(secureWriteMock).not.toHaveBeenCalled();
  });

  it.each(["read", "write"])("does not restart invalidated %s work after vault lock during backoff", async (phase) => {
    vi.useFakeTimers();
    const userId = `locked-retry-owner-${phase}`;
    const invalidate = () => PkmDomainResourceService.invalidateDomain(userId, "one_memory", {
      includeBackingCaches: true,
    });
    loadDomainDataWithBlobMock.mockImplementation(async () => {
      if (phase === "read") invalidate();
      return { data: { markdown: "private memory" }, blob: { dataVersion: 1 } };
    });
    secureWriteMock.mockImplementation(async () => {
      if (phase === "write") invalidate();
    });
    secureInvalidateMock.mockResolvedValue(undefined);
    try {
      const request = PkmDomainResourceService.refresh({
        userId, domain: "one_memory", vaultKey: "vault-key", vaultOwnerToken: "vault-owner",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce();
      const writesBeforeLock = secureWriteMock.mock.calls.length;
      advanceVaultSessionEpoch();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(request).resolves.toBeNull();
      expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce();
      expect(secureWriteMock).toHaveBeenCalledTimes(writesBeforeLock);
    } finally {
      vi.useRealTimers();
      secureWriteMock.mockReset();
    }
  });

  it("rejects a secure snapshot read that finishes after a domain clear", async () => {
    let resolveRead!: (value: unknown) => void;
    secureReadMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    secureInvalidateMock.mockResolvedValue(undefined);
    loadDomainDataWithBlobMock.mockResolvedValueOnce({
      data: { savedLocations: [] },
      blob: { dataVersion: 3, updatedAt: "2026-09-20T00:00:02.000Z" },
    });

    const request = PkmDomainResourceService.getStaleFirst({
      userId: "read-race-owner",
      domain: "location",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      backgroundRefresh: false,
    });
    await vi.waitFor(() => expect(secureReadMock).toHaveBeenCalledOnce());
    PkmDomainResourceService.invalidateDomain("read-race-owner", "location", {
      includeBackingCaches: true,
    });
    resolveRead({
      key: {
        userId: "read-race-owner",
        domain: "location",
        segmentIds: [],
        contentRevision: 2,
      },
      data: { savedLocations: [{ id: "deleted-place" }] },
      manifestRevision: null,
      updatedAt: "2026-09-20T00:00:01.000Z",
      audit: {
        cacheTier: "device",
        source: "secure_cache",
        refreshedAt: "2026-09-20T00:00:01.000Z",
      },
    });

    await expect(request).resolves.toEqual(
      expect.objectContaining({ data: { savedLocations: [] } }),
    );
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce();
    expect(secureInvalidateMock).toHaveBeenCalledWith(
      "read-race-owner",
      "pkm_domain:location:",
    );
  });

  it("waits for device eviction before reading after a domain clear", async () => {
    let resolveEviction!: () => void;
    let evictionComplete = false;
    secureInvalidateMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveEviction = () => {
          evictionComplete = true;
          resolve();
        };
      }),
    );
    secureReadMock.mockImplementationOnce(async () => {
      expect(evictionComplete).toBe(true);
      return null;
    });
    loadDomainDataWithBlobMock.mockResolvedValueOnce({
      data: { savedLocations: [] },
      blob: { dataVersion: 4, updatedAt: "2026-09-20T00:00:03.000Z" },
    });

    PkmDomainResourceService.invalidateDomain("eviction-owner", "location", {
      includeDevice: true,
      includeBackingCaches: true,
    });
    const request = PkmDomainResourceService.getStaleFirst({
      userId: "eviction-owner",
      domain: "location",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      backgroundRefresh: false,
    });
    await vi.waitFor(() => expect(secureInvalidateMock).toHaveBeenCalledOnce());
    expect(secureReadMock).not.toHaveBeenCalled();

    resolveEviction();

    await expect(request).resolves.toEqual(
      expect.objectContaining({ data: { savedLocations: [] } }),
    );
    expect(secureReadMock).toHaveBeenCalledOnce();
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce();
  });

  it("returns successful domains when another domain refresh fails", async () => {
    loadDomainDataWithBlobMock.mockImplementation(async ({ domain }) => {
      if (domain === "preferences") throw new Error("temporary unavailable");
      return {
        data: { profile: { risk_profile: "balanced" } },
        blob: { dataVersion: 1, updatedAt: "2026-05-18T05:55:00.000Z" },
      };
    });

    const result = await PkmDomainResourceService.getManyStaleFirst({
      userId: "user-batch",
      domains: ["financial", "preferences"],
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
      backgroundRefresh: false,
    });

    expect(result.snapshots.financial?.data).toEqual({ profile: { risk_profile: "balanced" } });
    expect(result.failedDomains).toEqual(["preferences"]);
  });

  it("prepares write context from the newer encrypted domain when memory is stale", async () => {
    const userId = "user-financial";
    const oldDomain = {
      portfolio: {
        holdings: [{ symbol: "OLD" }],
      },
    };
    const newDomain = {
      portfolio: {
        holdings: [{ symbol: "NEW" }],
      },
    };

    peekCachedDomainBlobMock.mockReturnValue({
      dataVersion: 2,
      updatedAt: "2026-05-18T05:55:00.000Z",
    });
    CacheService.getInstance().set(
      CACHE_KEYS.PKM_DOMAIN_RESOURCE(userId, "financial", "all"),
      {
        key: {
          userId,
          domain: "financial",
          segmentIds: [],
          contentRevision: 1,
        },
        data: oldDomain,
        manifestRevision: null,
        updatedAt: "2026-05-17T05:55:00.000Z",
        audit: {
          cacheTier: "memory",
          source: "cache",
          refreshedAt: "2026-05-17T05:55:00.000Z",
        },
      },
      CACHE_TTL.SESSION,
    );
    loadDomainSnapshotMock.mockResolvedValue({
      data: newDomain,
      snapshot: {
        contentRevision: 2,
        manifestRevision: 3,
        manifest: null,
        etag: "snapshot-etag",
        encryptedBlob: {
          dataVersion: 2,
          updatedAt: "2026-05-18T05:55:00.000Z",
        },
      },
    });

    const context = await PkmDomainResourceService.prepareDomainWriteContext({
      userId,
      domain: "financial",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner",
    });

    expect(context.domainData).toEqual(newDomain);
    expect(context.baseFullBlob).toEqual({ financial: newDomain });
    expect(context.expectedDataVersion).toBe(2);
  });
});
