import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhPersonalKnowledgeModel: {},
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  },
}));

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

describe("PKM cache behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
  });

  it("dedupes concurrent metadata fetches", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: "user-1",
          domains: [],
          total_attributes: 0,
          model_completeness: 0,
          suggested_domains: [],
          last_updated: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const [a, b] = await Promise.all([
      PersonalKnowledgeModelService.getMetadata("user-1", false, "vault-owner-token"),
      PersonalKnowledgeModelService.getMetadata("user-1", false, "vault-owner-token"),
    ]);

    expect(a.userId).toBe("user-1");
    expect(b.userId).toBe("user-1");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads encrypted user/domain blobs from cache on subsequent calls", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/pkm/data/user-1")) {
        return new Response(
          JSON.stringify({
            ciphertext: "ciphertext-user",
            iv: "iv-user",
            tag: "tag-user",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/pkm/domain-data/user-1/financial")) {
        return new Response(
          JSON.stringify({
            encrypted_blob: {
              ciphertext: "ciphertext-domain",
              iv: "iv-domain",
              tag: "tag-domain",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const blobFirst = await PersonalKnowledgeModelService.getEncryptedData("user-1", "vault-owner-token");
    const blobSecond = await PersonalKnowledgeModelService.getEncryptedData("user-1", "vault-owner-token");
    expect(blobFirst?.ciphertext).toBe("ciphertext-user");
    expect(blobSecond?.ciphertext).toBe("ciphertext-user");

    const domainFirst = await PersonalKnowledgeModelService.getDomainData(
      "user-1",
      "financial",
      "vault-owner-token"
    );
    const domainSecond = await PersonalKnowledgeModelService.getDomainData(
      "user-1",
      "financial",
      "vault-owner-token"
    );
    expect(domainFirst?.ciphertext).toBe("ciphertext-domain");
    expect(domainSecond?.ciphertext).toBe("ciphertext-domain");

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports targeted segment reads for manifest-backed paths", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/pkm/domain-data/user-1/health")) {
        return new Response(
          JSON.stringify({
            encrypted_blob: {
              ciphertext: "ciphertext-health",
              iv: "iv-health",
              tag: "tag-health",
              segments: {
                activities: {
                  ciphertext: "ciphertext-activities",
                  iv: "iv-activities",
                  tag: "tag-activities",
                },
              },
            },
            segment_ids: ["activities"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const manifest = {
      domain: "health",
      manifest_version: 1,
      summary_projection: {},
      top_level_scope_paths: ["activities"],
      externalizable_paths: ["activities.entities.mem_swim.summary"],
      paths: [
        {
          json_path: "activities",
          path_type: "object" as const,
          exposure_eligibility: true,
          segment_id: "activities",
        },
        {
          json_path: "activities.entities.mem_swim.summary",
          path_type: "leaf" as const,
          exposure_eligibility: true,
          segment_id: "activities",
        },
      ],
    };

    const segmentIds = PersonalKnowledgeModelService.resolveSegmentIdsForPaths({
      manifest,
      paths: ["activities.entities.mem_swim.summary"],
    });
    expect(segmentIds).toEqual(["activities"]);

    const domainBlob = await PersonalKnowledgeModelService.getDomainData(
      "user-1",
      "health",
      "vault-owner-token",
      segmentIds
    );

    expect(domainBlob?.segmentIds).toEqual(["activities"]);
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining("segment_ids=activities"),
      expect.any(Object)
    );
  });

  it("writes through and invalidates cache keys on PKM CRUD sync hooks", () => {
    const cache = CacheService.getInstance();
    const userId = "user-1";

    cache.set(CACHE_KEYS.PKM_METADATA(userId), {
      userId,
      domains: [],
      totalAttributes: 0,
      modelCompleteness: 0,
      suggestedDomains: [],
      lastUpdated: null,
    });

    CacheSyncService.onPkmDomainStored(userId, "financial", {
      portfolioData: {
        holdings: [{ symbol: "AAPL", name: "Apple", quantity: 10, price: 100, market_value: 1000 }],
      },
      encryptedBlob: {
        ciphertext: "cipher-blob",
        iv: "iv-blob",
        tag: "tag-blob",
      },
      domainSummary: {
        domain_key: "financial",
        holdings_count: 1,
      },
    });

    expect(cache.get(CACHE_KEYS.PORTFOLIO_DATA(userId))).toBeTruthy();
    expect(cache.get(CACHE_KEYS.PKM_BLOB(userId))).toBeNull();
    expect(cache.get(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, "financial"))).toBeTruthy();
    expect(cache.get(CACHE_KEYS.PKM_METADATA(userId))).toBeTruthy();

    CacheSyncService.onPortfolioUpserted(
      userId,
      { holdings: [{ symbol: "MSFT", name: "Microsoft", quantity: 3, price: 10, market_value: 30 }] },
      { invalidateMetadata: false }
    );
    expect(cache.get(CACHE_KEYS.PKM_METADATA(userId))).toBeTruthy();

    CacheSyncService.onPkmDomainCleared(userId, "financial");
    expect(cache.get(CACHE_KEYS.PORTFOLIO_DATA(userId))).toBeNull();
    expect(cache.get(CACHE_KEYS.PKM_BLOB(userId))).toBeNull();
    expect(cache.get(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, "financial"))).toBeNull();
    expect(cache.get(CACHE_KEYS.PKM_METADATA(userId))).toBeNull();
  });
});
