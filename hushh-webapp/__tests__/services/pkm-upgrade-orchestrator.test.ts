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

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

const pkmGetMetadataMock = vi.fn();
const pkmGetDomainDataMock = vi.fn();
const pkmLoadDomainDataMock = vi.fn();
const pkmGetDomainManifestMock = vi.fn();
const pkmStoreMergedDomainMock = vi.fn();
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PkmDomainManifestError: class PkmDomainManifestError extends Error {
    status: number;
    detail: string | null;
    correlationId: string | null;
    route: string;
    userId: string;
    domain: string;

    constructor(params: {
      status: number;
      detail?: string | null;
      correlationId?: string | null;
      route: string;
      userId: string;
      domain: string;
    }) {
      super(
        params.detail
          ? `Failed to get domain manifest (${params.status}): ${params.detail}`
          : `Failed to get domain manifest: ${params.status}`
      );
      this.name = "PkmDomainManifestError";
      this.status = params.status;
      this.detail = params.detail ?? null;
      this.correlationId = params.correlationId ?? null;
      this.route = params.route;
      this.userId = params.userId;
      this.domain = params.domain;
    }
  },
  PersonalKnowledgeModelService: {
    getMetadata: (...a: unknown[]) => pkmGetMetadataMock(...a),
    getDomainData: (...a: unknown[]) => pkmGetDomainDataMock(...a),
    loadDomainData: (...a: unknown[]) => pkmLoadDomainDataMock(...a),
    getDomainManifest: (...a: unknown[]) => pkmGetDomainManifestMock(...a),
    storeMergedDomain: (...a: unknown[]) => pkmStoreMergedDomainMock(...a),
    emptyMetadata: vi.fn(() => ({ domains: [] })),
  },
}));

const startOrResumeMock = vi.fn();
const updateStepMock = vi.fn();
const completeRunMock = vi.fn();
const failRunMock = vi.fn();
const getUpgradeStatusMock = vi.fn();
vi.mock("@/lib/services/pkm-upgrade-service", () => {
  class RouteUnavailable extends Error {
    constructor(msg?: string) {
      super(msg ?? "Route unavailable");
      this.name = "PkmUpgradeRouteUnavailableError";
    }
  }
  return {
    PkmUpgradeRouteUnavailableError: RouteUnavailable,
    PkmUpgradeService: {
      startOrResume: (...a: unknown[]) => startOrResumeMock(...a),
      updateStep: (...a: unknown[]) => updateStepMock(...a),
      completeRun: (...a: unknown[]) => completeRunMock(...a),
      failRun: (...a: unknown[]) => failRunMock(...a),
      getStatus: (...a: unknown[]) => getUpgradeStatusMock(...a),
    },
  };
});

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPortfolioUpserted: vi.fn(),
    onConsentMutated: vi.fn(),
  },
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
    getTask: vi.fn(() => null),
  },
}));

vi.mock("@/lib/personal-knowledge-model/upgrade-registry", () => ({
  runDomainUpgrade: vi.fn(() => ({
    domainData: { upgraded: true },
    newDomainContractVersion: 2,
    notes: ["Upgraded"],
  })),
  buildReadableUpgradeSummary: vi.fn(() => ({
    readable_summary: "test summary",
    readable_source_label: "PKM Upgrade",
    readable_summary_version: 1,
    readable_highlights: [],
  })),
}));

vi.mock("@/lib/personal-knowledge-model/manifest", () => ({
  buildPersonalKnowledgeModelStructureArtifacts: vi.fn(() => ({
    manifest: {
      domain: "food",
      manifest_version: 2,
      summary_projection: {},
      top_level_scope_paths: [],
      externalizable_paths: [],
      paths: [],
    },
  })),
}));

vi.mock("@/lib/utils/session-storage", () => ({
  getLocalItem: vi.fn(() => null),
  setLocalItem: vi.fn(),
  removeLocalItem: vi.fn(),
  getSessionItem: vi.fn(() => null),
  setSessionItem: vi.fn(),
}));

import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import { PkmUpgradeRouteUnavailableError } from "@/lib/services/pkm-upgrade-service";
import { PkmDomainManifestError } from "@/lib/services/personal-knowledge-model-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";

/* ---------- helpers ---------- */

const BASE_PARAMS = {
  userId: "user-upgrade-1",
  vaultKey: "vault-key-upgrade-1",
  vaultOwnerToken: "vault-owner-token-upgrade-1",
  initiatedBy: "test",
};

function _makeUpgradeStatus(overrides?: { steps?: unknown[]; runStatus?: string }) {
  return {
    upgradeStatus: overrides?.runStatus ?? "running",
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
    run: {
      runId: "run-abc",
      status: overrides?.runStatus ?? "running",
      currentDomain: "food",
      steps: overrides?.steps ?? [
        { domain: "food", status: "planned", attemptCount: 0 },
      ],
    },
  };
}

function setupSuccessfulUpgradeMocks() {
  startOrResumeMock.mockResolvedValue(_makeUpgradeStatus());
  updateStepMock.mockImplementation(async ({ status, checkpointPayload, attemptCount, domain }) => ({
    ..._makeUpgradeStatus({
      steps: [
        {
          domain,
          status,
          attemptCount: attemptCount ?? 1,
          checkpointPayload: checkpointPayload ?? null,
        },
      ],
      runStatus: status === "completed" ? "running" : "running",
    }),
  }));
  completeRunMock.mockResolvedValue({
    ..._makeUpgradeStatus({ steps: [{ domain: "food", status: "completed", attemptCount: 1 }] }),
    upgradeStatus: "current",
    upgradableDomains: [],
    run: {
      runId: "run-abc",
      status: "completed",
      currentDomain: null,
      steps: [{ domain: "food", status: "completed", attemptCount: 1 }],
    },
  });
  failRunMock.mockResolvedValue(undefined);
  pkmGetMetadataMock.mockResolvedValue({
    domains: [{ key: "food", summary: { item_count: 1 } }],
  });
  pkmGetDomainDataMock.mockResolvedValue({
    ciphertext: "cipher",
    iv: "iv",
    tag: "tag",
    dataVersion: 3,
  });
  pkmLoadDomainDataMock.mockResolvedValue({ pantry: { favorite: "tea" } });
  pkmGetDomainManifestMock.mockResolvedValue({
    domain: "food",
    manifest_version: 1,
    summary_projection: {},
  });
  pkmStoreMergedDomainMock.mockResolvedValue({
    success: true,
    conflict: false,
    dataVersion: 4,
  });
}

/* ---------- tests ---------- */

describe("PkmUpgradeOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal static state by leveraging a private field reset.
    // We need to clear inFlightByUser and routeUnavailableForSession.
    // Calling ensureRunning with a fresh user effectively tests fresh state,
    // but for routeUnavailableForSession we need to work around it.
    // We use Object.assign to reset the static flags between tests.
    (PkmUpgradeOrchestrator as unknown as Record<string, unknown>)[
      "routeUnavailableForSession"
    ] = false;
    (
      PkmUpgradeOrchestrator as unknown as Record<string, Map<string, unknown>>
    )["inFlightByUser"] = new Map();
    (
      PkmUpgradeOrchestrator as unknown as Record<string, Set<string>>
    )["pauseRequestedByUser"] = new Set();
    setupSuccessfulUpgradeMocks();
  });

  describe("deduplication", () => {
    it("deduplicates concurrent ensureRunning calls per user (only one runs)", async () => {
      let resolveInternal!: () => void;
      const blockingPromise = new Promise<void>((resolve) => {
        resolveInternal = resolve;
      });

      startOrResumeMock.mockImplementation(async () => {
        await blockingPromise;
        // Return status with no steps to complete immediately
        return {
          upgradeStatus: "current",
          upgradableDomains: [],
          run: null,
        };
      });

      const call1 = PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);
      const call2 = PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);

      // Resolve the blocking promise so both can finish
      resolveInternal();
      await Promise.all([call1, call2]);

      // startOrResume should only be called once
      expect(startOrResumeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("PkmUpgradeRouteUnavailableError handling", () => {
    it("sets routeUnavailableForSession=true and subsequent calls no-op", async () => {
      startOrResumeMock.mockRejectedValueOnce(
        new PkmUpgradeRouteUnavailableError("Route unavailable for test")
      );

      // First call: throws PkmUpgradeRouteUnavailableError internally, which disables for session
      await PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);

      expect(PkmUpgradeOrchestrator.isRouteUnavailableForSession()).toBe(true);

      // Second call should no-op immediately (not call startOrResume at all)
      startOrResumeMock.mockClear();
      await PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);
      expect(startOrResumeMock).not.toHaveBeenCalled();
    });
  });

  describe("isRouteUnavailableForSession", () => {
    it("returns true after a route-unavailable error", async () => {
      expect(PkmUpgradeOrchestrator.isRouteUnavailableForSession()).toBe(false);

      startOrResumeMock.mockRejectedValueOnce(
        new PkmUpgradeRouteUnavailableError("Route unavailable")
      );
      await PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);

      expect(PkmUpgradeOrchestrator.isRouteUnavailableForSession()).toBe(true);
    });
  });

  describe("completion cleanup", () => {
    it("clears in-flight entry on completion", async () => {
      startOrResumeMock.mockResolvedValue({
        upgradeStatus: "current",
        upgradableDomains: [],
        run: null,
      });

      await PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);

      // After completion, the in-flight map should be empty for this user.
      // Calling ensureRunning again should trigger a new startOrResume call.
      startOrResumeMock.mockClear();
      startOrResumeMock.mockResolvedValue({
        upgradeStatus: "current",
        upgradableDomains: [],
        run: null,
      });

      await PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS);
      expect(startOrResumeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("manifest compatibility and failure metadata", () => {
    it("treats a missing manifest as a supported compatibility path", async () => {
      pkmGetDomainManifestMock.mockResolvedValueOnce(null);

      await expect(PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS)).resolves.toBeUndefined();
      expect(pkmStoreMergedDomainMock).toHaveBeenCalledTimes(1);
      expect(completeRunMock).toHaveBeenCalledTimes(1);
    });

    it("records structured manifest failure metadata into the task center", async () => {
      const manifestError = new PkmDomainManifestError({
        status: 500,
        detail: "Failed to serialize Personal Knowledge Model manifest response.",
        correlationId: "corr-123",
        route: "/api/pkm/manifest/user-upgrade-1/food",
        userId: "user-upgrade-1",
        domain: "food",
      });
      pkmGetDomainManifestMock.mockRejectedValueOnce(manifestError);

      await expect(PkmUpgradeOrchestrator.ensureRunning(BASE_PARAMS)).rejects.toThrow(
        /Failed to serialize Personal Knowledge Model manifest response/
      );

      expect(AppBackgroundTaskService.failTask).toHaveBeenCalledWith(
        expect.stringContaining("pkm_upgrade_"),
        expect.stringContaining("Manifest read failed (500)"),
        expect.stringContaining("PKM refresh"),
        expect.objectContaining({
          domain: "food",
          stage: "run",
          httpStatus: 500,
          correlationId: "corr-123",
        })
      );
      expect(failRunMock).toHaveBeenCalledTimes(1);
    });
  });
});
