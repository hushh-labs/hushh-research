import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---------- mocks (before any real imports) ---------- */

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/firebase/config", () => ({
  app: {},
  auth: { currentUser: null },
  getRecaptchaVerifier: vi.fn(),
  resetRecaptcha: vi.fn(),
}));

const apiFetchMock = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  },
}));

const pkmGetMetadataMock = vi.fn();
const pkmGetDomainManifestMock = vi.fn();
const pkmGetDomainDataMock = vi.fn();
const pkmStoreMergedDomainWithPreparedBlobMock = vi.fn();
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...a: unknown[]) => pkmGetMetadataMock(...a),
    getDomainManifest: (...a: unknown[]) => pkmGetDomainManifestMock(...a),
    getDomainData: (...a: unknown[]) => pkmGetDomainDataMock(...a),
    storeMergedDomainWithPreparedBlob: (...a: unknown[]) =>
      pkmStoreMergedDomainWithPreparedBlobMock(...a),
    emptyMetadata: vi.fn(() => ({ domains: [], upgradableDomains: [] })),
    loadDomainData: vi.fn(),
  },
}));

const prepareDomainWriteContextMock = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    prepareDomainWriteContext: (...a: unknown[]) =>
      prepareDomainWriteContextMock(...a),
  },
}));

const upgradeEnsureRunningMock = vi.fn();
vi.mock("@/lib/services/pkm-upgrade-orchestrator", () => ({
  PkmUpgradeOrchestrator: {
    ensureRunning: (...a: unknown[]) => upgradeEnsureRunningMock(...a),
  },
}));

const upgradeGetStatusMock = vi.fn();
vi.mock("@/lib/services/pkm-upgrade-service", () => ({
  PkmUpgradeService: {
    getStatus: (...a: unknown[]) => upgradeGetStatusMock(...a),
  },
  PkmUpgradeRouteUnavailableError: class extends Error {
    constructor(msg?: string) {
      super(msg ?? "Route unavailable");
      this.name = "PkmUpgradeRouteUnavailableError";
    }
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPortfolioUpserted: vi.fn(),
    onConsentMutated: vi.fn(),
  },
}));

vi.mock("@/lib/personal-knowledge-model/upgrade-contracts", () => ({
  CURRENT_PKM_CONTRACT_VERSION: "6.0.0",
  CURRENT_READABLE_PROJECTION_VERSION: "6.0.0",
  CURRENT_READABLE_SUMMARY_VERSION: 1,
  comparePkmSemanticVersions: vi.fn((left: string, right: string) => left.localeCompare(right)),
  currentDomainContractVersion: vi.fn(() => 2),
}));

import {
  PkmWriteCoordinator,
} from "@/lib/services/pkm-write-coordinator";

/* ---------- helpers ---------- */

const BASE_PARAMS = {
  userId: "user-write-1",
  domain: "food",
  vaultKey: "vault-key-write-1",
  vaultOwnerToken: "vault-owner-token-write-1",
  confirmation: {
    confirmedByUser: true as const,
    surface: "web" as const,
    source: "pkm_write_coordinator_test",
  },
};

function stubNoUpgradeNeeded() {
  pkmGetMetadataMock.mockResolvedValue({
    upgradableDomains: [],
  });
  pkmGetDomainManifestMock.mockResolvedValue(null);
}

function stubWriteContext(overrides?: {
  baseFullBlob?: Record<string, unknown>;
  domainData?: Record<string, unknown>;
  expectedDataVersion?: number;
  currentEncryptedDomain?: Record<string, unknown> | null;
}) {
  prepareDomainWriteContextMock.mockResolvedValue({
    baseFullBlob: overrides?.baseFullBlob ?? { existing: { foo: "bar" } },
    domainData: overrides?.domainData ?? { items: [] },
    expectedDataVersion: overrides?.expectedDataVersion ?? 1,
  });
  pkmGetDomainDataMock.mockResolvedValue(overrides?.currentEncryptedDomain ?? null);
}

const BUILD_CALLBACK = vi.fn().mockImplementation(() => ({
  domainData: { favorite: "sushi" },
  summary: { item_count: 1 },
}));

/* ---------- tests ---------- */

describe("PkmWriteCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("blocked_pending_unlock", () => {
    it("returns blocked_pending_unlock when vaultKey is null", async () => {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        vaultKey: null,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("blocked_pending_unlock");
      expect(result.success).toBe(false);
      expect(BUILD_CALLBACK).not.toHaveBeenCalled();
    });

    it("returns blocked_pending_unlock when vaultOwnerToken is undefined", async () => {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        vaultOwnerToken: undefined,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("blocked_pending_unlock");
      expect(result.success).toBe(false);
    });
  });

  describe("successful write", () => {
    it("returns saved with conflict=false on a clean write", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext();
      pkmStoreMergedDomainWithPreparedBlobMock.mockResolvedValue({
        success: true,
        conflict: false,
        message: "Stored",
        dataVersion: 2,
        updatedAt: "2026-03-29T12:00:00Z",
        fullBlob: { existing: { foo: "bar" }, food: { favorite: "sushi" } },
      });

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("saved");
      expect(result.success).toBe(true);
      expect(result.conflict).toBe(false);
      expect(result.dataVersion).toBe(2);
      expect(BUILD_CALLBACK).toHaveBeenCalledTimes(1);
      expect(pkmStoreMergedDomainWithPreparedBlobMock).toHaveBeenCalledTimes(1);
      expect(pkmStoreMergedDomainWithPreparedBlobMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: BASE_PARAMS.userId,
          domain: BASE_PARAMS.domain,
          domainData: { favorite: "sushi" },
          summary: { item_count: 1 },
          syncCheckpoint: expect.objectContaining({
            schemaVersion: "pkm_sync_checkpoint.v1",
            source: "merged_domain",
            domain: BASE_PARAMS.domain,
            attempt: 0,
            expectedDataVersion: 1,
            conflictRetry: false,
          }),
        })
      );
      expect(result.syncCheckpoint).toMatchObject({
        schemaVersion: "pkm_sync_checkpoint.v1",
        source: "merged_domain",
        domain: BASE_PARAMS.domain,
        attempt: 0,
        expectedDataVersion: 1,
        resultDataVersion: 2,
        conflictRetry: false,
      });
    });

    it("uses current encrypted data version and manifest revision in deterministic sync checkpoints", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext({
        expectedDataVersion: 3,
        currentEncryptedDomain: {
          ciphertext: "cipher",
          iv: "iv",
          tag: "tag",
          dataVersion: 7,
        },
      });
      pkmGetDomainManifestMock.mockResolvedValue({
        domain: "food",
        manifest_version: 4,
        domain_contract_version: 2,
        readable_summary_version: 1,
      });
      pkmStoreMergedDomainWithPreparedBlobMock.mockResolvedValue({
        success: true,
        conflict: false,
        dataVersion: 8,
        fullBlob: { food: { favorite: "sushi" } },
      });

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: () => ({
          domainData: { favorite: "sushi" },
          summary: { item_count: 1 },
          manifest: {
            domain: "food",
            manifest_version: 5,
            summary_projection: {},
            top_level_scope_paths: [],
            externalizable_paths: [],
            paths: [],
          },
        }),
      });

      expect(result.syncCheckpoint).toMatchObject({
        checkpointKey:
          "pkm_sync_checkpoint.v1|merged_domain|food|attempt:0|expected:7|current_manifest:4|target_manifest:5|upgrade:none",
        expectedDataVersion: 7,
        resultDataVersion: 8,
        currentManifestVersion: 4,
        targetManifestVersion: 5,
      });
    });

    it("passes authoritative merge decisions through merged domain writes", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext({
        baseFullBlob: {
          financial: {
            portfolio: { holdings: [{ symbol: "OLD" }] },
          },
        },
      });
      pkmStoreMergedDomainWithPreparedBlobMock.mockResolvedValue({
        success: true,
        conflict: false,
        dataVersion: 2,
        fullBlob: {
          financial: {
            portfolio: { holdings: [{ symbol: "NEW" }] },
          },
        },
      });

      await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        domain: "financial",
        build: () => ({
          domainData: {
            portfolio: { holdings: [{ symbol: "NEW" }] },
          },
          summary: { item_count: 1 },
          mergeDecision: {
            merge_mode: "replace_domain",
            target_domain: "financial",
          },
        }),
      });

      expect(pkmStoreMergedDomainWithPreparedBlobMock).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: "financial",
          mergeDecision: {
            merge_mode: "replace_domain",
            target_domain: "financial",
          },
        }),
      );
    });

    it("records an explicitly confirmed merged-domain deletion as delete", async () => {
      pkmGetMetadataMock.mockResolvedValue({ upgradableDomains: [] });
      pkmGetDomainManifestMock.mockResolvedValue({
        domain: "food",
        manifest_version: 1,
        domain_contract_version: 2,
        readable_summary_version: 1,
        summary_projection: {},
        top_level_scope_paths: ["profile", "preferences"],
        externalizable_paths: [],
        paths: [],
      });
      stubWriteContext({ domainData: { favorite: "sushi" } });
      pkmStoreMergedDomainWithPreparedBlobMock.mockResolvedValue({
        success: true,
        conflict: false,
        dataVersion: 2,
        fullBlob: { food: {} },
      });

      await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: () => ({
          domainData: {},
          summary: { item_count: 0 },
          operation: "delete",
          scopePath: "preferences.favorite",
        }),
      });

      expect(pkmStoreMergedDomainWithPreparedBlobMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mutationPlan: expect.objectContaining({
            operation: "delete",
            proposed_scope: "preferences",
            confirmation_receipt: expect.objectContaining({
              displayed_scope: "preferences",
            }),
          }),
        })
      );
    });
  });

  describe("conflict retry", () => {
    it("retries on version conflict and succeeds on second attempt", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext();
      pkmStoreMergedDomainWithPreparedBlobMock
        .mockResolvedValueOnce({
          success: false,
          conflict: true,
          message: "Version conflict",
          dataVersion: 1,
          fullBlob: {},
        })
        .mockResolvedValueOnce({
          success: true,
          conflict: false,
          message: "Stored after retry",
          dataVersion: 3,
          updatedAt: "2026-03-29T12:01:00Z",
          fullBlob: { food: { favorite: "sushi" } },
        });

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("retrying_after_conflict");
      expect(result.success).toBe(true);
      expect(result.conflict).toBe(false);
      // Build callback called twice (initial + 1 retry)
      expect(BUILD_CALLBACK).toHaveBeenCalledTimes(2);
      expect(pkmStoreMergedDomainWithPreparedBlobMock).toHaveBeenCalledTimes(2);
    });

    it("returns failed with conflict=true after exceeding max retries", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext();
      // All 3 attempts (initial + 2 retries) return conflict
      pkmStoreMergedDomainWithPreparedBlobMock.mockResolvedValue({
        success: false,
        conflict: true,
        message: "Version conflict",
        dataVersion: 1,
        fullBlob: {},
      });

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("failed");
      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      // initial attempt + MAX_CONFLICT_RETRIES (2) = 3 total
      expect(pkmStoreMergedDomainWithPreparedBlobMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("upgrade path", () => {
    it("returns upgraded_and_saved when domain needs upgrade first", async () => {
      // First call to getMetadata: domain needs upgrade
      pkmGetMetadataMock.mockResolvedValue({
        upgradableDomains: [
          {
            domain: "food",
            needsUpgrade: true,
            currentDomainContractVersion: 1,
            targetDomainContractVersion: 2,
            currentReadableSummaryVersion: 0,
            targetReadableSummaryVersion: 1,
          },
        ],
      });
      pkmGetDomainManifestMock.mockResolvedValue({
        domain: "food",
        manifest_version: 1,
        domain_contract_version: 1,
        readable_summary_version: 0,
      });
      upgradeEnsureRunningMock.mockResolvedValue(undefined);
      upgradeGetStatusMock.mockResolvedValue({
        upgradableDomains: [
          {
            domain: "food",
            targetDomainContractVersion: 2,
            targetReadableSummaryVersion: 1,
          },
        ],
        run: { runId: "run-123" },
      });
      stubWriteContext();
      pkmStoreMergedDomainWithPreparedBlobMock.mockResolvedValue({
        success: true,
        conflict: false,
        message: "Stored after upgrade",
        dataVersion: 4,
        updatedAt: "2026-03-29T12:02:00Z",
        fullBlob: { food: { favorite: "sushi" } },
      });

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("upgraded_and_saved");
      expect(result.success).toBe(true);
      expect(result.conflict).toBe(false);
      expect(upgradeEnsureRunningMock).toHaveBeenCalledTimes(1);
    });

    it("fails closed before writing when the saved model requires a newer client", async () => {
      pkmGetMetadataMock.mockResolvedValue({
        upgradeStatus: "client_update_required",
        upgradableDomains: [],
      });
      pkmGetDomainManifestMock.mockResolvedValue(null);

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("failed");
      expect(result.success).toBe(false);
      expect(pkmStoreMergedDomainWithPreparedBlobMock).not.toHaveBeenCalled();
    });
  });

  describe("backend write throws", () => {
    it("converts a thrown storeDomainData 500 into a graceful failed result instead of propagating", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext();
      pkmStoreMergedDomainWithPreparedBlobMock.mockRejectedValue(
        new Error(
          'Failed to store domain data: 500 - {"detail":"Failed to store domain data"}',
        ),
      );

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("failed");
      expect(result.success).toBe(false);
      // The raw backend error text must never reach the caller/UI verbatim.
      expect(result.message).not.toContain("Failed to store domain data: 500");
      expect(result.message).toMatch(/vault/i);
    });

    it("requires recipient re-review when sharing changes during the write", async () => {
      stubNoUpgradeNeeded();
      stubWriteContext();
      pkmStoreMergedDomainWithPreparedBlobMock.mockRejectedValue(
        new Error('409 {"code":"PKM_SHARING_IMPACT_CHANGED"}')
      );

      const result = await PkmWriteCoordinator.saveMergedDomain({
        ...BASE_PARAMS,
        build: BUILD_CALLBACK,
      });

      expect(result.saveState).toBe("failed");
      expect(result.message).toMatch(/sharing changed/i);
      expect(result.message).toMatch(/confirm again/i);
    });
  });
});
