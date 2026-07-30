// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  domainData: {} as Record<string, unknown>,
  revision: 0,
  updatedAt: "2026-07-30T00:00:00.000Z",
  loadDomainDataWithBlob: vi.fn(),
  loadDomainSnapshot: vi.fn(),
  storeMergedDomainWithPreparedBlob: vi.fn(),
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    invalidateResourcePrefix: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-upgrade-orchestrator", () => ({
  PkmUpgradeOrchestrator: {
    ensureRunning: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-upgrade-service", () => ({
  PkmUpgradeService: {
    getStatus: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: vi.fn().mockResolvedValue({
      upgradableDomains: [],
    }),
    getDomainManifest: vi.fn().mockResolvedValue(null),
    peekCachedDomainBlob: vi.fn(() =>
      persistence.revision > 0
        ? {
            dataVersion: persistence.revision,
            updatedAt: persistence.updatedAt,
          }
        : null,
    ),
    loadDomainSnapshot: (...args: unknown[]) =>
      persistence.loadDomainSnapshot(...args),
    loadDomainDataWithBlob: (...args: unknown[]) =>
      persistence.loadDomainDataWithBlob(...args),
    storeMergedDomainWithPreparedBlob: (...args: unknown[]) =>
      persistence.storeMergedDomainWithPreparedBlob(...args),
  },
}));

import {
  addSavedLocation,
  loadSavedLocations,
} from "@/lib/one-location/saved-locations";
import { CacheService } from "@/lib/services/cache-service";

const CONTEXT = {
  userId: "settings-owner",
  vaultKey: "vault-key",
  vaultOwnerToken: "vault-owner-token",
};

describe("saved-place onboarding to Settings persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
    persistence.domainData = {};
    persistence.revision = 0;
    persistence.updatedAt = "2026-07-30T00:00:00.000Z";

    persistence.loadDomainSnapshot.mockImplementation(async () => ({
      data: persistence.domainData,
      snapshot:
        persistence.revision > 0
          ? {
              contentRevision: persistence.revision,
              manifestRevision: null,
              manifest: null,
              etag: `location-${persistence.revision}`,
              encryptedBlob: {
                dataVersion: persistence.revision,
                updatedAt: persistence.updatedAt,
              },
            }
          : null,
    }));
    persistence.loadDomainDataWithBlob.mockImplementation(async () => ({
      data: persistence.domainData,
      blob:
        persistence.revision > 0
          ? {
              dataVersion: persistence.revision,
              updatedAt: persistence.updatedAt,
            }
          : null,
    }));
    persistence.storeMergedDomainWithPreparedBlob.mockImplementation(
      async (params: {
        domain: string;
        domainData: Record<string, unknown>;
      }) => {
        persistence.revision += 1;
        persistence.domainData = params.domainData;
        return {
          success: true,
          conflict: false,
          message: "Stored",
          dataVersion: persistence.revision,
          updatedAt: persistence.updatedAt,
          fullBlob: {
            [params.domain]: persistence.domainData,
          },
        };
      },
    );
  });

  it("round-trips an edited onboarding place through the real PKM coordinator and Settings reader", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "work",
        label: "",
        latitude: 12.9716,
        longitude: 77.5946,
        address: "Hushh Office, Bengaluru, Karnataka, India",
      },
    });

    CacheService.getInstance().clear();
    const settingsLocations = await loadSavedLocations(CONTEXT);

    expect(settingsLocations).toEqual([
      expect.objectContaining({
        id: "work",
        category: "work",
        label: "Work",
        latitude: 12.9716,
        longitude: 77.5946,
        address: "Hushh Office, Bengaluru, Karnataka, India",
      }),
    ]);
    expect(
      persistence.storeMergedDomainWithPreparedBlob,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "location",
        domainData: expect.objectContaining({
          saved_places: expect.objectContaining({
            schema_version: 1,
          }),
        }),
      }),
    );
    expect(persistence.loadDomainDataWithBlob).toHaveBeenCalledWith({
      userId: CONTEXT.userId,
      domain: "location",
      vaultKey: CONTEXT.vaultKey,
      vaultOwnerToken: CONTEXT.vaultOwnerToken,
      segmentIds: undefined,
    });
  });
});
