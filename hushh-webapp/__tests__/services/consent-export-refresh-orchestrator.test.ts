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

const listJobsMock = vi.fn();
const uploadRefreshedExportMock = vi.fn();
const failJobMock = vi.fn();
vi.mock("@/lib/services/consent-export-refresh-service", () => ({
  ConsentExportRefreshService: {
    listJobs: (...a: unknown[]) => listJobsMock(...a),
    uploadRefreshedExport: (...a: unknown[]) => uploadRefreshedExportMock(...a),
    failJob: (...a: unknown[]) => failJobMock(...a),
  },
}));

const startTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const completeTaskMock = vi.fn();
const failTaskMock = vi.fn();
vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: (...a: unknown[]) => startTaskMock(...a),
    updateTask: (...a: unknown[]) => updateTaskMock(...a),
    completeTask: (...a: unknown[]) => completeTaskMock(...a),
    failTask: (...a: unknown[]) => failTaskMock(...a),
    getTask: vi.fn(() => null),
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPortfolioUpserted: vi.fn(),
    onConsentMutated: vi.fn(),
  },
}));

vi.mock("@/lib/consent/export-builder", () => ({
  buildConsentExportForScope: vi.fn(() =>
    Promise.resolve({
      payload: { data: "test" },
      sourceContentRevision: 1,
      sourceManifestRevision: 1,
    })
  ),
}));

vi.mock("@/lib/vault/export-encrypt", () => ({
  generateExportKey: vi.fn(() => Promise.resolve("hex-key-1")),
  encryptForExport: vi.fn(() =>
    Promise.resolve({
      ciphertext: "cipher-1",
      iv: "iv-1",
      tag: "tag-1",
    })
  ),
  wrapExportKeyForConnector: vi.fn(() =>
    Promise.resolve({
      wrappedExportKey: "wrapped-key-1",
      wrappedKeyIv: "wk-iv-1",
      wrappedKeyTag: "wk-tag-1",
      senderPublicKey: "sender-pk-1",
      wrappingAlg: "X25519-AES256-GCM",
      connectorKeyId: "ck-1",
    })
  ),
}));

import { ConsentExportRefreshOrchestrator } from "@/lib/services/consent-export-refresh-orchestrator";

/* ---------- helpers ---------- */

const BASE_PARAMS = {
  userId: "user-consent-1",
  vaultKey: "vault-key-consent-1",
  vaultOwnerToken: "vault-owner-token-consent-1",
  initiatedBy: "test",
};

function makeJob(overrides?: Partial<Record<string, unknown>>) {
  return {
    consentToken: overrides?.consentToken ?? "ct-1",
    grantedScope: overrides?.grantedScope ?? "pkm.read",
    connectorPublicKey: overrides?.connectorPublicKey ?? "pk-1",
    connectorKeyId: overrides?.connectorKeyId ?? "ck-1",
    connectorWrappingAlg:
      overrides?.connectorWrappingAlg ?? "X25519-AES256-GCM",
    status: overrides?.status ?? "pending",
    triggerDomain: overrides?.triggerDomain ?? "food",
    triggerPaths: overrides?.triggerPaths ?? ["food.profile"],
    requestedAt: overrides?.requestedAt ?? "2026-03-29T10:00:00Z",
    attemptCount: overrides?.attemptCount ?? 0,
    lastError: overrides?.lastError ?? null,
    exportRevision: overrides?.exportRevision ?? null,
    exportRefreshStatus: overrides?.exportRefreshStatus ?? null,
  };
}

/* ---------- tests ---------- */

describe("ConsentExportRefreshOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal static state
    (
      ConsentExportRefreshOrchestrator as unknown as Record<
        string,
        Map<string, unknown>
      >
    )["inFlightByUser"] = new Map();
    (
      ConsentExportRefreshOrchestrator as unknown as Record<
        string,
        Set<string>
      >
    )["pauseRequestedByUser"] = new Set();
  });

  describe("deduplication", () => {
    it("deduplicates concurrent ensureRunning calls for same userId", async () => {
      let resolveListJobs!: (value: unknown[]) => void;
      const blockingPromise = new Promise<unknown[]>((resolve) => {
        resolveListJobs = resolve;
      });

      listJobsMock.mockImplementation(async () => blockingPromise);

      const call1 = ConsentExportRefreshOrchestrator.ensureRunning(BASE_PARAMS);
      const call2 = ConsentExportRefreshOrchestrator.ensureRunning(BASE_PARAMS);

      // Resolve with zero jobs for a quick completion
      resolveListJobs([]);
      await Promise.all([call1, call2]);

      // listJobs should only be called once even though ensureRunning was called twice
      expect(listJobsMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("pauseForLocalAuthResume", () => {
    it("causes in-progress run to pause", async () => {
      const jobs = [makeJob(), makeJob({ consentToken: "ct-2" })];
      listJobsMock.mockResolvedValue(jobs);
      uploadRefreshedExportMock.mockImplementation(async () => {
        // Simulate pause being requested during job processing
        ConsentExportRefreshOrchestrator.pauseForLocalAuthResume({
          userId: BASE_PARAMS.userId,
        });
        return {};
      });

      await ConsentExportRefreshOrchestrator.ensureRunning(BASE_PARAMS);

      // After pause, updateTask should be called with a pause description
      expect(updateTaskMock).toHaveBeenCalledWith(
        expect.stringContaining(BASE_PARAMS.userId),
        expect.objectContaining({
          description: expect.stringContaining("Unlock your vault"),
          metadata: expect.objectContaining({
            pausedForLocalAuth: true,
          }),
        })
      );
    });
  });

  describe("zero jobs", () => {
    it("completes immediately when there are no jobs", async () => {
      listJobsMock.mockResolvedValue([]);

      await ConsentExportRefreshOrchestrator.ensureRunning(BASE_PARAMS);

      expect(completeTaskMock).toHaveBeenCalledWith(
        expect.stringContaining(BASE_PARAMS.userId),
        expect.stringContaining("current")
      );
      expect(startTaskMock).not.toHaveBeenCalled();
      expect(uploadRefreshedExportMock).not.toHaveBeenCalled();
    });
  });

  describe("completion cleanup", () => {
    it("clears in-flight entry on completion so next call re-runs", async () => {
      listJobsMock.mockResolvedValue([]);

      await ConsentExportRefreshOrchestrator.ensureRunning(BASE_PARAMS);
      expect(listJobsMock).toHaveBeenCalledTimes(1);

      // After completion, calling again should invoke a new run
      listJobsMock.mockClear();
      listJobsMock.mockResolvedValue([]);

      await ConsentExportRefreshOrchestrator.ensureRunning(BASE_PARAMS);
      expect(listJobsMock).toHaveBeenCalledTimes(1);
    });
  });
});
