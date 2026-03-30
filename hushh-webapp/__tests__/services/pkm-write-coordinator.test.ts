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
  CURRENT_READABLE_SUMMARY_VERSION: 1,
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
}) {
  prepareDomainWriteContextMock.mockResolvedValue({
    baseFullBlob: overrides?.baseFullBlob ?? { existing: { foo: "bar" } },
    domainData: overrides?.domainData ?? { items: [] },
    expectedDataVersion: overrides?.expectedDataVersion ?? 1,
  });
  pkmGetDomainDataMock.mockResolvedValue(null);
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
  });
});
