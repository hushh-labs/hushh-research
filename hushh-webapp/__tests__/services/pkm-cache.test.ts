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

vi.mock("@/lib/firebase/config", () => ({
  auth: {
    currentUser: null,
  },
}));

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import {
  PersonalKnowledgeModelService,
  PkmScopeExposureError,
} from "@/lib/services/personal-knowledge-model-service";

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

  it("falls back to stale metadata instead of caching an empty state on unauthorized responses", async () => {
    const userId = "user-1";
    const cache = CacheService.getInstance();
    const staleMetadata = {
      userId,
      domains: [
        {
          key: "financial",
          displayName: "Financial",
          icon: "wallet",
          color: "#123456",
          attributeCount: 12,
          summary: { readable_summary: "Portfolio imported" },
          availableScopes: ["attr.financial.*"],
          lastUpdated: "2026-04-14T12:00:00Z",
        },
      ],
      totalAttributes: 12,
      modelCompleteness: 20,
      modelVersion: 4,
      storedModelVersion: 4,
      effectiveModelVersion: 4,
      targetModelVersion: 4,
      upgradeStatus: "current",
      upgradableDomains: [],
      lastUpgradedAt: null,
      suggestedDomains: [],
      lastUpdated: "2026-04-14T12:00:00Z",
    };
    cache.set(CACHE_KEYS.PKM_METADATA(userId), staleMetadata, -1);

    apiFetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const result = await PersonalKnowledgeModelService.getMetadata(userId, false, "vault-owner-token");

    expect(result).toEqual(staleMetadata);
    expect(CacheService.getInstance().peek(CACHE_KEYS.PKM_METADATA(userId))?.data).toEqual(staleMetadata);
  });

  it("does not trust a fresh empty metadata cache entry when a network fetch can return real domains", async () => {
    const userId = "user-1";
    const cache = CacheService.getInstance();
    cache.set(CACHE_KEYS.PKM_METADATA(userId), PersonalKnowledgeModelService.emptyMetadata(userId), 60_000);

    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: userId,
          domains: [
            {
              domain_key: "financial",
              display_name: "Financial",
              icon_name: "wallet",
              color_hex: "#D4AF37",
              attribute_count: 19,
              summary: { item_count: 19 },
              available_scopes: ["attr.financial.*"],
              last_updated: "2026-04-15T10:00:00Z",
            },
          ],
          total_attributes: 19,
          model_completeness: 80,
          model_version: 4,
          target_model_version: 4,
          upgrade_status: "current",
          upgradable_domains: [],
          suggested_domains: [],
          last_updated: "2026-04-15T10:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await PersonalKnowledgeModelService.getMetadata(userId, false, "vault-owner-token");

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]?.key).toBe("financial");
    expect(result.totalAttributes).toBe(19);
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

  it("caches domain manifests, including missing manifests, and supports forced refresh", async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            domain: "financial",
            manifest_version: 3,
            summary_projection: {},
            top_level_scope_paths: ["portfolio"],
            externalizable_paths: [],
            paths: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            domain: "financial",
            manifest_version: 4,
            summary_projection: {},
            top_level_scope_paths: ["portfolio", "documents"],
            externalizable_paths: [],
            paths: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const first = await PersonalKnowledgeModelService.getDomainManifest(
      "user-1",
      "financial",
      "vault-owner-token"
    );
    const second = await PersonalKnowledgeModelService.getDomainManifest(
      "user-1",
      "financial",
      "vault-owner-token"
    );
    expect(first?.manifest_version).toBe(3);
    expect(second?.manifest_version).toBe(3);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    CacheService.getInstance().invalidate(CACHE_KEYS.DOMAIN_MANIFEST("user-1", "financial"));
    const missing = await PersonalKnowledgeModelService.getDomainManifest(
      "user-1",
      "financial",
      "vault-owner-token"
    );
    expect(missing).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    const cachedMissing = await PersonalKnowledgeModelService.getDomainManifest(
      "user-1",
      "financial",
      "vault-owner-token"
    );
    expect(cachedMissing).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    const refreshed = await PersonalKnowledgeModelService.getDomainManifest(
      "user-1",
      "financial",
      "vault-owner-token",
      true
    );
    expect(refreshed?.manifest_version).toBe(4);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it("writes returned manifests through cache after scope exposure updates", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          manifest_version: 9,
          revoked_grant_count: 1,
          revoked_grant_ids: ["grant-1"],
          manifest: {
            domain: "financial",
            manifest_version: 9,
            summary_projection: {},
            top_level_scope_paths: ["portfolio"],
            externalizable_paths: [],
            paths: [],
            scope_registry: [
              {
                scope_handle: "financial.portfolio",
                scope_label: "Portfolio",
                segment_ids: ["portfolio"],
                exposure_enabled: false,
                summary_projection: {
                  top_level_scope_path: "portfolio",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await PersonalKnowledgeModelService.updateScopeExposure({
      userId: "user-1",
      domain: "financial",
      vaultOwnerToken: "vault-owner-token",
      expectedManifestVersion: 8,
      changes: [
        {
          scopeHandle: "financial.portfolio",
          topLevelScopePath: "portfolio",
          exposureEnabled: false,
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.manifestVersion).toBe(9);
    expect(
      CacheService.getInstance().get(CACHE_KEYS.DOMAIN_MANIFEST("user-1", "financial"))
    ).toEqual(result.manifest);
  });

  it("throws a typed conflict error for manifest version mismatches", async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: "PKM_MANIFEST_CONFLICT",
            message: "PKM manifest changed. Refresh and retry.",
            current_manifest_version: 12,
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      PersonalKnowledgeModelService.updateScopeExposure({
        userId: "user-1",
        domain: "financial",
        vaultOwnerToken: "vault-owner-token",
        expectedManifestVersion: 11,
        changes: [
          {
            scopeHandle: "financial.portfolio",
            topLevelScopePath: "portfolio",
            exposureEnabled: false,
          },
        ],
      })
    ).rejects.toMatchObject({
      name: "PkmScopeExposureError",
      status: 409,
      currentManifestVersion: 12,
    } satisfies Partial<PkmScopeExposureError>);
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
