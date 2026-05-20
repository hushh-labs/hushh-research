import { beforeEach, describe, expect, it, vi } from "vitest";

const peekCachedDomainBlobMock = vi.fn();
const loadDomainDataWithBlobMock = vi.fn();
const secureReadMock = vi.fn();
const secureWriteMock = vi.fn();

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    peekCachedDomainBlob: (...args: unknown[]) => peekCachedDomainBlobMock(...args),
    loadDomainDataWithBlob: (...args: unknown[]) => loadDomainDataWithBlobMock(...args),
  },
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: (...args: unknown[]) => secureReadMock(...args),
    write: (...args: unknown[]) => secureWriteMock(...args),
    invalidateResourcePrefix: vi.fn(),
  },
}));

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
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
    loadDomainDataWithBlobMock.mockResolvedValue({
      data: newDomain,
      blob: {
        dataVersion: 2,
        updatedAt: "2026-05-18T05:55:00.000Z",
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
