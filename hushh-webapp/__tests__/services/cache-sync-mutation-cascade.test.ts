import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/kai/kai-financial-resource", () => ({
  KaiFinancialResourceService: { invalidate: vi.fn() },
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { invalidateDomain: vi.fn() },
}));
vi.mock("@/lib/kai/kai-market-home-resource", () => ({
  KaiMarketHomeResourceService: { invalidateUser: vi.fn() },
}));
vi.mock("@/lib/services/unlock-warm-orchestrator", () => ({
  UnlockWarmOrchestrator: { invalidateForUser: vi.fn() },
}));

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";

describe("CacheSyncService mutation cascades", () => {
  const userId = "test-user-123";
  let cache: CacheService;
  let spyInvalidate: ReturnType<typeof vi.spyOn>;
  let spyInvalidatePattern: ReturnType<typeof vi.spyOn>;
  let spyInvalidateUser: ReturnType<typeof vi.spyOn>;
  let spySet: ReturnType<typeof vi.spyOn>;
  let spyClear: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cache = CacheService.getInstance();
    cache.clear();
    spyInvalidate = vi.spyOn(cache, "invalidate");
    spyInvalidatePattern = vi.spyOn(cache, "invalidatePattern");
    spyInvalidateUser = vi.spyOn(cache, "invalidateUser");
    spySet = vi.spyOn(cache, "set");
    spyClear = vi.spyOn(cache, "clear");
  });

  afterEach(() => {
    cache.clear();
    vi.restoreAllMocks();
  });

  // ---------- 1. onConsentMutated ----------
  it("onConsentMutated invalidates consent, RIA, and vault caches plus pattern prefixes", () => {
    CacheSyncService.onConsentMutated(userId);

    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.ACTIVE_CONSENTS(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PENDING_CONSENTS(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.CONSENT_AUDIT_LOG(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.CONSENT_CENTER(userId, "all"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "investor"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "ria"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_HOME(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_ROSTER_SUMMARY(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.VAULT_STATUS(userId));

    const patternArgs = spyInvalidatePattern.mock.calls.map((c) => c[0]);
    expect(patternArgs).toContain(`consent_center_list_${userId}_`);
    expect(patternArgs).toContain(`ria_clients_${userId}_`);
    expect(patternArgs).toContain(`ria_client_detail_${userId}_`);
    expect(patternArgs).toContain(`ria_workspace_${userId}_`);
  });

  // ---------- 2. onPersonaStateChanged without preservePersonaState ----------
  it("onPersonaStateChanged invalidates PERSONA_STATE and RIA caches when preservePersonaState is falsy", () => {
    CacheSyncService.onPersonaStateChanged(userId);

    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.PERSONA_STATE(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_HOME(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_ROSTER_SUMMARY(userId));
  });

  // ---------- 3. onPersonaStateChanged with preservePersonaState ----------
  it("onPersonaStateChanged with preservePersonaState skips PERSONA_STATE but still clears RIA caches", () => {
    CacheSyncService.onPersonaStateChanged(userId, { preservePersonaState: true });

    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).not.toContain(CACHE_KEYS.PERSONA_STATE(userId));

    // RIA caches must still be invalidated
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_HOME(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.RIA_ROSTER_SUMMARY(userId));
  });

  // ---------- 4. onAuthSignedOut(userId) ----------
  it("onAuthSignedOut with userId delegates to cache.invalidateUser", () => {
    CacheSyncService.onAuthSignedOut(userId);

    expect(spyInvalidateUser).toHaveBeenCalledWith(userId);
    expect(spyClear).not.toHaveBeenCalled();
  });

  // ---------- 5. onAuthSignedOut() (no userId) ----------
  it("onAuthSignedOut without userId calls cache.clear()", () => {
    CacheSyncService.onAuthSignedOut();

    expect(spyClear).toHaveBeenCalled();
    expect(spyInvalidateUser).not.toHaveBeenCalled();
  });

  // ---------- 6. onAccountDeleted ----------
  it("onAccountDeleted delegates to onAuthSignedOut(userId)", () => {
    CacheSyncService.onAccountDeleted(userId);

    expect(spyInvalidateUser).toHaveBeenCalledWith(userId);
  });

  // ---------- 7. onVaultStateChanged with hasVault: true ----------
  it("onVaultStateChanged(hasVault: true) sets VAULT_CHECK to SESSION TTL and invalidates VAULT_STATUS", () => {
    CacheSyncService.onVaultStateChanged(userId, { hasVault: true });

    expect(spySet).toHaveBeenCalledWith(
      CACHE_KEYS.VAULT_CHECK(userId),
      true,
      CACHE_TTL.SESSION
    );
    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.VAULT_STATUS(userId));
  });

  // ---------- 8. onVaultStateChanged with hasVault: false ----------
  it("onVaultStateChanged(hasVault: false) sets VAULT_CHECK, invalidates VAULT_STATUS, and invalidates financial resource", () => {
    CacheSyncService.onVaultStateChanged(userId, { hasVault: false });

    expect(spySet).toHaveBeenCalledWith(
      CACHE_KEYS.VAULT_CHECK(userId),
      false,
      CACHE_TTL.SESSION
    );
    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.VAULT_STATUS(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.KAI_FINANCIAL_RESOURCE(userId));
  });

  // ---------- 9. onPkmDomainStored (financial) ----------
  it("onPkmDomainStored for financial domain sets PORTFOLIO_DATA and DOMAIN_DATA to SESSION and invalidates PKM_DECRYPTED_BLOB", () => {
    const portfolioData = {
      holdings: [{ symbol: "AAPL", shares: 10 }],
    };

    CacheSyncService.onPkmDomainStored(userId, "financial", {
      portfolioData: portfolioData as any,
    });

    expect(spySet).toHaveBeenCalledWith(
      CACHE_KEYS.PORTFOLIO_DATA(userId),
      portfolioData,
      CACHE_TTL.SESSION
    );
    expect(spySet).toHaveBeenCalledWith(
      CACHE_KEYS.DOMAIN_DATA(userId, "financial"),
      portfolioData,
      CACHE_TTL.SESSION
    );

    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));
  });

  // ---------- 10. onPkmDomainCleared (financial) ----------
  it("onPkmDomainCleared invalidates domain data, encrypted blob, PKM blob, decrypted blob, metadata, and portfolio data for financial", () => {
    CacheSyncService.onPkmDomainCleared(userId, "financial");

    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, "financial"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_BLOB(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_METADATA(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PORTFOLIO_DATA(userId));
  });

  // ---------- 11. onAnalysisHistoryMutated ----------
  it("onAnalysisHistoryMutated invalidates analysis history, PKM caches, financial domain, metadata, and STOCK_CONTEXT for given ticker", () => {
    CacheSyncService.onAnalysisHistoryMutated(userId, "AAPL");

    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.ANALYSIS_HISTORY(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_BLOB(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, "financial"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
    expect(invalidatedKeys).toContain(CACHE_KEYS.PKM_METADATA(userId));
    expect(invalidatedKeys).toContain(CACHE_KEYS.STOCK_CONTEXT(userId, "AAPL"));
  });

  // ---------- 12. onAnalysisHistoryStored ----------
  it("onAnalysisHistoryStored sets ANALYSIS_HISTORY to SESSION and invalidates STOCK_CONTEXT for given ticker", () => {
    const historyMap = { AAPL: [{ ts: 1 }] };

    CacheSyncService.onAnalysisHistoryStored(userId, historyMap, "AAPL");

    expect(spySet).toHaveBeenCalledWith(
      CACHE_KEYS.ANALYSIS_HISTORY(userId),
      historyMap,
      CACHE_TTL.SESSION
    );
    const invalidatedKeys = spyInvalidate.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContain(CACHE_KEYS.STOCK_CONTEXT(userId, "AAPL"));
  });
});
