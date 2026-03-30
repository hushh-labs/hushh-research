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

const apiGetVaultStatusMock = vi.fn();
const apiGetActiveConsentsMock = vi.fn();
const apiGetPendingConsentsMock = vi.fn();
const apiGetConsentHistoryMock = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getVaultStatus: (...a: unknown[]) => apiGetVaultStatusMock(...a),
    getActiveConsents: (...a: unknown[]) => apiGetActiveConsentsMock(...a),
    getPendingConsents: (...a: unknown[]) => apiGetPendingConsentsMock(...a),
    getConsentHistory: (...a: unknown[]) => apiGetConsentHistoryMock(...a),
    apiFetch: vi.fn(),
  },
}));

const pkmGetMetadataMock = vi.fn();
const pkmLoadDomainDataMock = vi.fn();
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...a: unknown[]) => pkmGetMetadataMock(...a),
    loadDomainData: (...a: unknown[]) => pkmLoadDomainDataMock(...a),
    emptyMetadata: vi.fn(() => ({ domains: [] })),
  },
}));

const financialHydrateMock = vi.fn();
const financialPrimeMock = vi.fn();
vi.mock("@/lib/kai/kai-financial-resource", () => ({
  KaiFinancialResourceService: {
    hydrateFromSecureCache: (...a: unknown[]) => financialHydrateMock(...a),
    primeFromFinancialDomain: (...a: unknown[]) => financialPrimeMock(...a),
  },
}));

const profileSyncMock = vi.fn();
vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: (...a: unknown[]) => profileSyncMock(...a),
  },
}));

const upgradeEnsureRunningMock = vi.fn();
vi.mock("@/lib/services/pkm-upgrade-orchestrator", () => ({
  PkmUpgradeOrchestrator: {
    ensureRunning: (...a: unknown[]) => upgradeEnsureRunningMock(...a),
  },
}));

const consentRefreshEnsureRunningMock = vi.fn();
vi.mock("@/lib/services/consent-export-refresh-orchestrator", () => ({
  ConsentExportRefreshOrchestrator: {
    ensureRunning: (...a: unknown[]) => consentRefreshEnsureRunningMock(...a),
  },
}));

vi.mock("@/lib/services/cache-service", () => {
  const store = new Map<string, unknown>();
  return {
    CacheService: {
      getInstance: () => ({
        get: (key: string) => store.get(key) ?? null,
        set: (key: string, value: unknown) => store.set(key, value),
        delete: (key: string) => store.delete(key),
        clear: () => store.clear(),
      }),
    },
    CACHE_KEYS: {
      VAULT_STATUS: (uid: string) => `vault_status:${uid}`,
      ACTIVE_CONSENTS: (uid: string) => `active_consents:${uid}`,
      PENDING_CONSENTS: (uid: string) => `pending_consents:${uid}`,
      CONSENT_AUDIT_LOG: (uid: string) => `consent_audit:${uid}`,
      KAI_MARKET_HOME: (uid: string, sk: string, d: number, ps: string) =>
        `kai_market:${uid}:${sk}:${d}:${ps}`,
      KAI_DASHBOARD_PROFILE_PICKS: (uid: string, sk: string, n: number) =>
        `kai_dash_picks:${uid}:${sk}:${n}`,
      KAI_PROFILE: (uid: string) => `kai_profile:${uid}`,
    },
  };
});

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onPortfolioUpserted: vi.fn(),
    onConsentMutated: vi.fn(),
  },
}));

vi.mock("@/lib/kai/pick-source-selection", () => ({
  getKaiActivePickSource: vi.fn(() => "kai"),
}));

const appBackgroundStartTaskMock = vi.fn();
const appBackgroundCompleteTaskMock = vi.fn();
const appBackgroundFailTaskMock = vi.fn();
vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: (...a: unknown[]) => appBackgroundStartTaskMock(...a),
    completeTask: (...a: unknown[]) => appBackgroundCompleteTaskMock(...a),
    failTask: (...a: unknown[]) => appBackgroundFailTaskMock(...a),
  },
}));

vi.mock("@/lib/utils/portfolio-normalize", () => ({
  normalizeStoredPortfolio: vi.fn((raw: unknown) => raw),
}));

import {
  UnlockWarmOrchestrator,
} from "@/lib/services/unlock-warm-orchestrator";

/* ---------- helpers ---------- */

const BASE_PARAMS = {
  userId: "user-warm-1",
  vaultKey: "vault-key-warm-1",
  vaultOwnerToken: "abcdefghijklmnopqrstuvwxyz0123456789",
};

function okJsonResponse(data: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve(data),
  };
}

function setupDefaultMocks() {
  profileSyncMock.mockResolvedValue({ synced: true, reason: "synced" });
  pkmGetMetadataMock.mockResolvedValue({ domains: [] });
  pkmLoadDomainDataMock.mockResolvedValue(null);
  financialHydrateMock.mockResolvedValue(null);
  apiGetVaultStatusMock.mockResolvedValue(okJsonResponse({ status: "active" }));
  apiGetActiveConsentsMock.mockResolvedValue(okJsonResponse({ active: [] }));
  apiGetPendingConsentsMock.mockResolvedValue(okJsonResponse({ pending: [] }));
  apiGetConsentHistoryMock.mockResolvedValue(okJsonResponse({ items: [] }));
  upgradeEnsureRunningMock.mockResolvedValue(undefined);
  consentRefreshEnsureRunningMock.mockResolvedValue(undefined);
}

/* ---------- tests ---------- */

describe("UnlockWarmOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear internal static state between tests
    UnlockWarmOrchestrator.invalidateForUser(BASE_PARAMS.userId);
    UnlockWarmOrchestrator.invalidateForUser("user-dedup-1");
  });

  describe("resolveWarmPriority (tested indirectly via run())", () => {
    it('resolves "/kai" to "market" priority -- warms market data and still queues pkm upgrade', async () => {
      setupDefaultMocks();
      const result = await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: "/kai",
      });
      // market priority skips profile sync (metadata warm = false)
      expect(profileSyncMock).not.toHaveBeenCalled();
      expect(upgradeEnsureRunningMock).toHaveBeenCalledTimes(1);
      expect(appBackgroundStartTaskMock).toHaveBeenCalledTimes(1);
      expect(appBackgroundCompleteTaskMock).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it('resolves "/kai/portfolio" to "dashboard" priority -- warms metadata', async () => {
      setupDefaultMocks();
      const result = await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: "/kai/portfolio",
      });
      // dashboard priority warms metadata, so profile sync is called
      expect(profileSyncMock).toHaveBeenCalledTimes(1);
      expect(result.metadataWarmed).toBe(true);
    });

    it('resolves "/kai/dashboard/analysis" to "analysis" priority -- warms metadata', async () => {
      setupDefaultMocks();
      const result = await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: "/kai/dashboard/analysis",
      });
      // analysis priority warms metadata
      expect(profileSyncMock).toHaveBeenCalledTimes(1);
      expect(result.metadataWarmed).toBe(true);
    });

    it('resolves "/consents" to "consents" priority -- queues consent export refresh and pkm upgrade', async () => {
      setupDefaultMocks();
      await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: "/consents",
      });
      // consents priority queues consent export refresh
      expect(consentRefreshEnsureRunningMock).toHaveBeenCalledTimes(1);
      expect(upgradeEnsureRunningMock).toHaveBeenCalledTimes(1);
    });

    it('resolves "/profile" to "profile" priority -- queues pkm upgrade', async () => {
      setupDefaultMocks();
      await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: "/profile",
      });
      // profile priority queues pkm upgrade
      expect(upgradeEnsureRunningMock).toHaveBeenCalledTimes(1);
    });

    it('resolves "/ria" to "ria" priority -- skips heavy warm-ups but still queues pkm upgrade', async () => {
      setupDefaultMocks();
      const result = await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: "/ria",
      });
      // ria priority skips metadata warm, financial warm, consents, market, dashboard picks
      expect(profileSyncMock).not.toHaveBeenCalled();
      expect(pkmLoadDomainDataMock).not.toHaveBeenCalled();
      expect(upgradeEnsureRunningMock).toHaveBeenCalledTimes(1);
      expect(result.metadataWarmed).toBe(false);
      expect(result.financialWarmed).toBe(false);
    });

    it('resolves null routePath to "default" priority -- warms everything and queues pkm upgrade', async () => {
      setupDefaultMocks();
      const result = await UnlockWarmOrchestrator.run({
        ...BASE_PARAMS,
        routePath: undefined,
      });
      // default priority warms metadata, consents, market, dashboard picks, financial
      expect(profileSyncMock).toHaveBeenCalledTimes(1);
      expect(pkmGetMetadataMock).toHaveBeenCalled();
      expect(apiGetActiveConsentsMock).toHaveBeenCalled();
      expect(upgradeEnsureRunningMock).toHaveBeenCalledTimes(1);
      expect(result.metadataWarmed).toBe(true);
      expect(result.consentsWarmed).toBe(true);
    });
  });

  describe("deduplication", () => {
    it("shares a single promise when run() is called twice concurrently with same userId+vaultKey", async () => {
      setupDefaultMocks();
      let _runInternalCallCount = 0;
      const originalLoadDomain = pkmLoadDomainDataMock;
      originalLoadDomain.mockImplementation(async () => {
        runInternalCallCount += 1;
        return null;
      });

      const params = {
        userId: "user-dedup-1",
        vaultKey: "vault-key-dedup-1",
        vaultOwnerToken: "abcdefghijklmnopqrstuvwxyz0123456789",
      };

      const [result1, result2] = await Promise.all([
        UnlockWarmOrchestrator.run(params),
        UnlockWarmOrchestrator.run(params),
      ]);

      // Both should resolve to the same result
      expect(result1).toEqual(result2);
      // Profile sync should only be called once (single run)
      expect(profileSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidateForUser", () => {
    it("clears cached results so the next run() re-executes", async () => {
      setupDefaultMocks();

      // First run populates the recent result cache
      await UnlockWarmOrchestrator.run({ ...BASE_PARAMS });
      expect(profileSyncMock).toHaveBeenCalledTimes(1);

      // Second run without invalidation returns the cached result
      await UnlockWarmOrchestrator.run({ ...BASE_PARAMS });
      // Still only 1 call because the result is cached
      expect(profileSyncMock).toHaveBeenCalledTimes(1);

      // Invalidate the user
      UnlockWarmOrchestrator.invalidateForUser(BASE_PARAMS.userId);

      // Third run should re-execute because cache was cleared
      await UnlockWarmOrchestrator.run({ ...BASE_PARAMS });
      expect(profileSyncMock).toHaveBeenCalledTimes(2);
    });
  });
});
