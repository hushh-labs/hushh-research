import { beforeEach, describe, expect, it, vi } from "vitest";

const secureReadMock = vi.fn();
const secureWriteMock = vi.fn();
const loadDomainDataWithBlobMock = vi.fn();
const peekCachedDomainBlobMock = vi.fn();

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: (...args: unknown[]) => secureReadMock(...args),
    write: (...args: unknown[]) => secureWriteMock(...args),
    invalidateResourcePrefix: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainDataWithBlob: (...args: unknown[]) => loadDomainDataWithBlobMock(...args),
    peekCachedDomainBlob: (...args: unknown[]) => peekCachedDomainBlobMock(...args),
  },
}));

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";

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
  beforeEach(() => {
    CacheService.getInstance().clear();
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
