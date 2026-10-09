import { beforeEach, describe, expect, it, vi } from "vitest";

const secureReadMock = vi.fn();
const secureWriteMock = vi.fn();
const loadDomainDataWithBlobMock = vi.fn();
const peekCachedDomainBlobMock = vi.fn();
const getMetadataMock = vi.fn();
const invalidateResourcePrefixMock = vi.fn();

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: (...args: unknown[]) => secureReadMock(...args),
    write: (...args: unknown[]) => secureWriteMock(...args),
    invalidateResourcePrefix: (...args: unknown[]) => invalidateResourcePrefixMock(...args),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainDataWithBlob: (...args: unknown[]) => loadDomainDataWithBlobMock(...args),
    peekCachedDomainBlob: (...args: unknown[]) => peekCachedDomainBlobMock(...args),
    getMetadata: (...args: unknown[]) => getMetadataMock(...args),
  },
}));

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";

function makeSnapshot() {
  return {
    key: {
      userId: "user-1",
      domain: "financial",
      segmentIds: [],
      contentRevision: 1,
    },
    data: {
      profile: {
        onboarding: {
          completed: true,
        },
      },
    },
    manifestRevision: 2,
    updatedAt: "2026-05-11T00:00:00.000Z",
    audit: {
      cacheTier: "device" as const,
      source: "secure_cache" as const,
      refreshedAt: "2026-05-11T00:00:00.000Z",
    },
  };
}

describe("PkmDomainResourceService cache consent guard", () => {
  it("a renewed Review loads a complete inventory without joining an old forced load", async () => {
    const userId = "renewal-inventory-owner";
    const params = { userId, vaultKey: "synthetic-key", vaultOwnerToken: "old-token", forceRefresh: true };
    getMetadataMock.mockResolvedValue({ domains: [{ key: "professional" }], lastUpdated: null });
    let finishOld!: (result: { data: Record<string, unknown>; blob: null }) => void;
    loadDomainDataWithBlobMock.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    const old = AgentPkmContextStore.load(params);
    await vi.waitFor(() => expect(loadDomainDataWithBlobMock).toHaveBeenCalledOnce());
    advanceVaultSessionEpoch();
    loadDomainDataWithBlobMock.mockResolvedValueOnce({ data: { businesses: { entities: {
      example: { name: "Current business", _business_origin: { business_uid: "business-current" } },
    } } }, blob: null });
    const current = await AgentPkmContextStore.load({ ...params, vaultOwnerToken: "renewed-token" });
    expect(current).not.toBeNull();
    expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(2);
    expect(AgentPkmContextStore.findBusinessReconciliationCandidates({ userId, businessUid: "business-current" })).toHaveLength(1);
    finishOld({ data: { name: "Obsolete business" }, blob: null });
    expect(await old).toBeNull();
    expect(AgentPkmContextStore.findBusinessReconciliationCandidates({ userId, businessUid: "business-current" })).toHaveLength(1);
    advanceVaultSessionEpoch();
    expect(AgentPkmContextStore.peek({ userId })).toBeNull();
  });

  it("old-session device cleanup finishes before a renewed snapshot is persisted", async () => {
    const params = { userId: "device-renewal-owner", domain: "professional", vaultKey: "synthetic-key", vaultOwnerToken: "old-token" };
    let finishWrite!: () => void;
    const events: string[] = [];
    loadDomainDataWithBlobMock.mockResolvedValueOnce({ data: { name: "Old business" }, blob: null });
    secureWriteMock.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; events.push("old write"); }));
    const old = PkmDomainResourceService.refresh(params);
    await vi.waitFor(() => expect(secureWriteMock).toHaveBeenCalledOnce());
    advanceVaultSessionEpoch();
    loadDomainDataWithBlobMock.mockResolvedValueOnce({ data: { name: "Current business" }, blob: null });
    secureWriteMock.mockImplementationOnce(async () => { events.push("current write"); });
    invalidateResourcePrefixMock.mockImplementationOnce(async () => { events.push("cleanup"); });
    const current = PkmDomainResourceService.refresh({ ...params, vaultOwnerToken: "renewed-token" });
    await vi.waitFor(() => expect(loadDomainDataWithBlobMock).toHaveBeenCalledTimes(2));
    expect(secureWriteMock).toHaveBeenCalledOnce();
    finishWrite();
    expect(await old).toBeNull();
    expect((await current)?.data).toEqual({ name: "Current business" });
    expect(events).toEqual(["old write", "cleanup", "current write"]);
  });
  it("discards a late decrypted result after the vault session changes", async () => {
    let finish!: (result: { data: Record<string, unknown>; blob: null }) => void;
    loadDomainDataWithBlobMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = PkmDomainResourceService.refresh({ userId: "user-1", domain: "professional",
      vaultKey: "vault-key", vaultOwnerToken: "owner-token" });
    advanceVaultSessionEpoch();
    finish({ data: { name: "synthetic business" }, blob: null });
    expect(await old).toBeNull();
    expect(secureWriteMock).not.toHaveBeenCalled();
    expect(CacheService.getInstance().get(CACHE_KEYS.DOMAIN_DATA("user-1", "professional"))).toBeNull();

    loadDomainDataWithBlobMock.mockResolvedValueOnce({ data: { name: "current business" }, blob: null });
    const current = await PkmDomainResourceService.refresh({ userId: "user-1", domain: "professional",
      vaultKey: "vault-key", vaultOwnerToken: "renewed-token" });
    expect(current?.data).toEqual({ name: "current business" });
    expect(secureWriteMock).toHaveBeenCalledOnce();
    expect(loadDomainDataWithBlobMock.mock.calls[1]![0]).toMatchObject({ forceRefresh: true });
  });
  beforeEach(() => {
    CacheService.getInstance().clear();
    AgentPkmContextStore.clear();
    vi.clearAllMocks();
    peekCachedDomainBlobMock.mockReturnValue(null);
  });

  it("does not write secure-cache hydration results into memory cache without user consent", async () => {
    secureReadMock.mockResolvedValueOnce(makeSnapshot());

    const result = await PkmDomainResourceService.hydrateFromSecureCache({
      userId: "user-1",
      domain: "financial",
      vaultKey: "vault-key",
    });

    expect(result?.data).toEqual(makeSnapshot().data);
    expect(CacheService.getInstance().get(CACHE_KEYS.DOMAIN_DATA("user-1", "financial"))).toBeNull();
    expect(
      CacheService.getInstance().get(CACHE_KEYS.PKM_DOMAIN_RESOURCE("user-1", "financial", "all"))
    ).toBeNull();
  });

  it("does not write network PKM results into memory or secure cache without user consent", async () => {
    loadDomainDataWithBlobMock.mockResolvedValueOnce({
      data: makeSnapshot().data,
      blob: {
        ciphertext: "ciphertext",
        iv: "iv",
        tag: "tag",
        dataVersion: 1,
        manifestRevision: 2,
        updatedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const result = await PkmDomainResourceService.refresh({
      userId: "user-1",
      domain: "financial",
      vaultKey: "vault-key",
    });

    expect(result?.data).toEqual(makeSnapshot().data);
    expect(secureWriteMock).not.toHaveBeenCalled();
    expect(CacheService.getInstance().get(CACHE_KEYS.DOMAIN_DATA("user-1", "financial"))).toBeNull();
    expect(
      CacheService.getInstance().get(CACHE_KEYS.PKM_DOMAIN_RESOURCE("user-1", "financial", "all"))
    ).toBeNull();
  });
});
