"use client";

import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { getKaiActivePickSource } from "@/lib/kai/pick-source-selection";
import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { ConsentExportRefreshOrchestrator } from "@/lib/services/consent-export-refresh-orchestrator";
import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";
import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";

export type UnlockWarmResult = {
  onboardingSynced: boolean;
  metadataWarmed: boolean;
  financialWarmed: boolean;
  kaiMarketWarmed: boolean;
  dashboardPicksWarmed: boolean;
  consentsWarmed: boolean;
  vaultStatusWarmed: boolean;
};

type WarmPriority =
  | "market"
  | "dashboard"
  | "analysis"
  | "consents"
  | "profile"
  | "ria"
  | "default";

const WARM_CACHE_TTL_MS = 10 * 60 * 1000;
const RECENT_WARM_RESULT_TTL_MS = 10 * 60 * 1000;
const TICKER_CANDIDATE_RE = /^[A-Z][A-Z0-9.-]{0,5}$/;
const EXCLUDED_SYMBOLS = new Set([
  "CASH",
  "MMF",
  "SWEEP",
  "QACDS",
  "BUY",
  "SELL",
  "REINVEST",
  "DIVIDEND",
  "INTEREST",
  "TRANSFER",
  "WITHDRAWAL",
  "DEPOSIT",
]);
const UNLOCK_WARM_TASK_KIND = "unlock_warm";
const PASSIVE_TASK_VISIBLE_AFTER_MS = 750;
const PASSIVE_TASK_AUTO_CLEAR_AFTER_MS = 10_000;

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

function resolveWarmPriority(routePath?: string | null): WarmPriority {
  const path = String(routePath || "").trim().toLowerCase();
  if (!path) return "default";
  if (path === "/kai" || path.startsWith("/kai?")) return "market";
  if (
    path.startsWith("/kai/dashboard/analysis") ||
    path.startsWith("/kai/analysis")
  ) {
    return "analysis";
  }
  if (
    path.startsWith("/kai/portfolio") ||
    path.startsWith("/kai/dashboard") ||
    path.startsWith("/kai/optimize")
  ) {
    return "dashboard";
  }
  if (path.startsWith("/consents")) return "consents";
  if (path.startsWith("/profile")) return "profile";
  if (path.startsWith("/ria")) return "ria";
  return "default";
}

function deriveTrackedSymbols(portfolio: Record<string, unknown>): string[] {
  const nestedPortfolio =
    portfolio.portfolio &&
    typeof portfolio.portfolio === "object" &&
    !Array.isArray(portfolio.portfolio)
      ? (portfolio.portfolio as Record<string, unknown>)
      : null;
  const holdings = (
    (Array.isArray(portfolio.holdings) && portfolio.holdings) ||
    (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
    []
  ) as Array<Record<string, unknown>>;

  return holdings
    .filter((holding) => {
      const assetType = String(holding.asset_type || "").trim().toLowerCase();
      const name = String(holding.name || "").trim().toLowerCase();
      if (assetType.includes("cash") || assetType.includes("sweep")) return false;
      if (name.includes("cash") || name.includes("sweep")) return false;
      return true;
    })
    .map((holding) => String(holding.symbol || "").trim().toUpperCase())
    .filter(
      (symbol, index, arr) =>
        Boolean(symbol) &&
        !EXCLUDED_SYMBOLS.has(symbol) &&
        !symbol.startsWith("HOLDING_") &&
        TICKER_CANDIDATE_RE.test(symbol) &&
        arr.indexOf(symbol) === index
    )
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8);
}

export class UnlockWarmOrchestrator {
  private static inFlightBySignature = new Map<string, Promise<UnlockWarmResult>>();
  private static inFlightByUser = new Map<string, Promise<UnlockWarmResult>>();
  private static recentResultBySignature = new Map<
    string,
    { completedAt: number; result: UnlockWarmResult }
  >();

  private static queuePkmUpgrade(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): void {
    void PkmUpgradeOrchestrator.ensureRunning({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      initiatedBy: "unlock_warm",
    }).catch((error) => {
      console.warn("[UnlockWarmOrchestrator] PKM upgrade orchestration failed:", error);
    });
  }

  private static queueConsentExportRefresh(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): void {
    void ConsentExportRefreshOrchestrator.ensureRunning({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      initiatedBy: "unlock_warm",
    }).catch((error) => {
      console.warn(
        "[UnlockWarmOrchestrator] Consent export refresh orchestration failed:",
        error
      );
    });
  }

  static invalidateForUser(userId: string): void {
    for (const key of this.recentResultBySignature.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.recentResultBySignature.delete(key);
      }
    }
  }

  static async awaitInFlightForUser(
    userId: string,
    timeoutMs = 2_000
  ): Promise<UnlockWarmResult | null> {
    const existing = this.inFlightByUser.get(userId);
    if (!existing) return null;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        existing,
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  static async run(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    routePath?: string;
  }): Promise<UnlockWarmResult> {
    const warmPriority = resolveWarmPriority(params.routePath);
    const tokenSignature = params.vaultOwnerToken.slice(0, 24);
    const signature = `${params.userId}:${tokenSignature}:${warmPriority}`;
    const now = Date.now();

    const recent = this.recentResultBySignature.get(signature);
    if (recent && now - recent.completedAt <= RECENT_WARM_RESULT_TTL_MS) {
      return recent.result;
    }

    const existing = this.inFlightBySignature.get(signature);
    if (existing) {
      return existing;
    }

    const promise = this.runInternal(params)
      .then((result) => {
        this.recentResultBySignature.set(signature, {
          completedAt: Date.now(),
          result,
        });
        return result;
      })
      .finally(() => {
        this.inFlightBySignature.delete(signature);
        const currentByUser = this.inFlightByUser.get(params.userId);
        if (currentByUser === promise) {
          this.inFlightByUser.delete(params.userId);
        }
      });

    this.inFlightBySignature.set(signature, promise);
    this.inFlightByUser.set(params.userId, promise);
    return promise;
  }

  private static async runInternal(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    routePath?: string;
  }): Promise<UnlockWarmResult> {
    const cache = CacheService.getInstance();
    const warmPriority = resolveWarmPriority(params.routePath);
    const activePickSource = getKaiActivePickSource(params.userId);
    const shouldHydrateFinancialCacheOnly = warmPriority === "market";
    const shouldWarmFinancial =
      warmPriority === "dashboard" ||
      warmPriority === "analysis" ||
      warmPriority === "default";
    const shouldWarmMarket =
      warmPriority === "market" ||
      warmPriority === "default";
    const shouldWarmDashboardPicks =
      warmPriority === "dashboard" ||
      warmPriority === "default";
    const shouldWarmMetadata =
      warmPriority === "profile" ||
      warmPriority === "dashboard" ||
      warmPriority === "analysis" ||
      warmPriority === "default";
    const shouldWarmConsents = warmPriority === "consents" || warmPriority === "default";
    const shouldWarmVaultStatus =
      warmPriority === "consents" ||
      warmPriority === "profile" ||
      warmPriority === "default";
    const taskId = `${UNLOCK_WARM_TASK_KIND}_${params.userId}_${warmPriority}`;
    AppBackgroundTaskService.startTask({
      taskId,
      userId: params.userId,
      kind: UNLOCK_WARM_TASK_KIND,
      title: "Refreshing signed-in workspace",
      description: "Warming secure data and cached views in the background.",
      visibility: "passive",
      groupLabel: "Background activity",
      visibleAfterMs: PASSIVE_TASK_VISIBLE_AFTER_MS,
      autoClearAfterMs: PASSIVE_TASK_AUTO_CLEAR_AFTER_MS,
      metadata: {
        routePath: params.routePath || null,
        warmPriority,
      },
    });
    try {
    const result: UnlockWarmResult = {
      onboardingSynced: false,
      metadataWarmed: false,
      financialWarmed: false,
      kaiMarketWarmed: false,
      dashboardPicksWarmed: false,
      consentsWarmed: false,
      vaultStatusWarmed: false,
    };
    let symbols: string[] = [];
    let prewarmedFinancialDomain: Record<string, unknown> | null = null;
    let financialHydrated = false;

    const syncPromise =
      shouldWarmMetadata
        ? KaiProfileSyncService.syncPendingToVault({
            userId: params.userId,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
          })
        : Promise.resolve({ synced: false, reason: "skipped_for_route" } as const);

    if (shouldWarmFinancial || shouldHydrateFinancialCacheOnly) {
      const hydratedFinancial = await KaiFinancialResourceService.hydrateFromSecureCache({
        userId: params.userId,
        vaultKey: params.vaultKey,
      }).catch(() => null);
      if (hydratedFinancial) {
        result.financialWarmed = hydratedFinancial.hasFinancialData;
        symbols = Array.isArray(hydratedFinancial.holdings)
          ? hydratedFinancial.holdings.slice(0, 8)
          : [];
        financialHydrated = hydratedFinancial.hasFinancialData;
      }
    }

    if (shouldWarmFinancial) {
      try {
        prewarmedFinancialDomain = await PersonalKnowledgeModelService.loadDomainData({
          userId: params.userId,
          domain: "financial",
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
        });
        const hydrated = this.hydrateFinancialCaches({
          cache,
          userId: params.userId,
          financialDomain: prewarmedFinancialDomain,
        });
        financialHydrated = hydrated.financialWarmed;
        result.financialWarmed = hydrated.financialWarmed;
        symbols = hydrated.symbols;
      } catch (error) {
        console.warn("[UnlockWarmOrchestrator] Priority financial warm-up failed:", error);
      }
    }

    try {
      const syncResult = await syncPromise;
      result.onboardingSynced = syncResult.synced;
    } catch (error) {
      console.warn("[UnlockWarmOrchestrator] Pending onboarding sync failed:", error);
    }

    const [
      metadataResult,
      vaultStatusResult,
      consentsResult,
      pendingResult,
      auditResult,
      financialDomainResult,
    ] = await Promise.allSettled([
      shouldWarmMetadata
        ? PersonalKnowledgeModelService.getMetadata(params.userId, false, params.vaultOwnerToken)
        : Promise.resolve(null),
      shouldWarmVaultStatus
        ? ApiService.getVaultStatus(params.userId, params.vaultOwnerToken)
        : Promise.resolve(null),
      shouldWarmConsents
        ? ApiService.getActiveConsents(params.userId, params.vaultOwnerToken)
        : Promise.resolve(null),
      shouldWarmConsents
        ? ApiService.getPendingConsents(params.userId, params.vaultOwnerToken)
        : Promise.resolve(null),
      shouldWarmConsents
        ? ApiService.getConsentHistory(params.userId, params.vaultOwnerToken, 1, 50)
        : Promise.resolve(null),
      shouldWarmFinancial
        ? prewarmedFinancialDomain
          ? Promise.resolve(prewarmedFinancialDomain)
          : PersonalKnowledgeModelService.loadDomainData({
              userId: params.userId,
              domain: "financial",
              vaultKey: params.vaultKey,
              vaultOwnerToken: params.vaultOwnerToken,
            })
        : Promise.resolve(null),
    ]);

    result.metadataWarmed = shouldWarmMetadata && metadataResult.status === "fulfilled";

    if (
      shouldWarmVaultStatus &&
      vaultStatusResult.status === "fulfilled" &&
      vaultStatusResult.value &&
      "ok" in vaultStatusResult.value &&
      vaultStatusResult.value.ok
    ) {
      const statusData = await vaultStatusResult.value.json();
      cache.set(CACHE_KEYS.VAULT_STATUS(params.userId), statusData, WARM_CACHE_TTL_MS);
      result.vaultStatusWarmed = true;
    }

    if (
      shouldWarmConsents &&
      consentsResult.status === "fulfilled" &&
      consentsResult.value &&
      "ok" in consentsResult.value &&
      consentsResult.value.ok
    ) {
      const consentsData = await consentsResult.value.json();
      cache.set(CACHE_KEYS.ACTIVE_CONSENTS(params.userId), consentsData.active || [], WARM_CACHE_TTL_MS);
      result.consentsWarmed = true;
    }

    if (
      shouldWarmConsents &&
      pendingResult.status === "fulfilled" &&
      pendingResult.value &&
      "ok" in pendingResult.value &&
      pendingResult.value.ok
    ) {
      const pendingData = (await pendingResult.value.json()).pending || [];
      cache.set(CACHE_KEYS.PENDING_CONSENTS(params.userId), pendingData, WARM_CACHE_TTL_MS);
      result.consentsWarmed = true;
    }

    if (
      shouldWarmConsents &&
      auditResult.status === "fulfilled" &&
      auditResult.value &&
      "ok" in auditResult.value &&
      auditResult.value.ok
    ) {
      const data = await auditResult.value.json();
      const auditData = Array.isArray(data) ? data : data?.items ?? data?.history ?? [];
      cache.set(CACHE_KEYS.CONSENT_AUDIT_LOG(params.userId), auditData, WARM_CACHE_TTL_MS);
      result.consentsWarmed = true;
    }

    if (
      shouldWarmFinancial &&
      !financialHydrated &&
      financialDomainResult.status === "fulfilled" &&
      financialDomainResult.value
    ) {
      const hydrated = this.hydrateFinancialCaches({
        cache,
        userId: params.userId,
        financialDomain: financialDomainResult.value,
      });
      result.financialWarmed = hydrated.financialWarmed;
      symbols = hydrated.symbols;
    }

    if (shouldWarmDashboardPicks && symbols.length > 0) {
      const picksSymbolsKey = toSymbolsKey(symbols);
      const picksCacheKey = CACHE_KEYS.KAI_DASHBOARD_PROFILE_PICKS(
        params.userId,
        picksSymbolsKey,
        3
      );
      result.dashboardPicksWarmed = Boolean(cache.get(picksCacheKey));
    } else if (shouldWarmDashboardPicks) {
      result.dashboardPicksWarmed = true;
    }

    if (shouldWarmMarket) {
      const symbolsKey = toSymbolsKey(symbols);
      const preferredCacheKey = CACHE_KEYS.KAI_MARKET_HOME(
        params.userId,
        symbolsKey,
        7,
        activePickSource
      );
      const defaultCacheKey = CACHE_KEYS.KAI_MARKET_HOME(
        params.userId,
        "default",
        7,
        activePickSource
      );
      result.kaiMarketWarmed = Boolean(
        cache.get(preferredCacheKey) || cache.get(defaultCacheKey)
      );
    }

    this.queuePkmUpgrade(params);
    if (warmPriority === "consents") {
      this.queueConsentExportRefresh(params);
    }
    AppBackgroundTaskService.completeTask(
      taskId,
      "Background activity is current.",
      {
        routePath: params.routePath || null,
        warmPriority,
        result,
      }
    );
    return result;
  } catch (error) {
    AppBackgroundTaskService.failTask(
      taskId,
      error instanceof Error ? error.message : "Background activity failed.",
      "Background activity needs attention.",
      {
        routePath: params.routePath || null,
        warmPriority,
      }
    );
    throw error;
  }
  }

  private static hydrateFinancialCaches(params: {
    cache: CacheService;
    userId: string;
    financialDomain: Record<string, unknown> | null;
  }): { financialWarmed: boolean; symbols: string[] } {
    const financialRaw = params.financialDomain;
    if (!financialRaw || typeof financialRaw !== "object" || Array.isArray(financialRaw)) {
      return { financialWarmed: false, symbols: [] };
    }

    const financial = financialRaw as Record<string, unknown>;
    const normalized = normalizeStoredPortfolio(financial);
    CacheSyncService.onPortfolioUpserted(params.userId, normalized, {
      invalidateMetadata: false,
    });
    KaiFinancialResourceService.primeFromFinancialDomain({
      userId: params.userId,
      financialDomain: financial,
      cacheTier: "memory",
      source: "network",
    });

    const profileCandidate = financial.profile;
    if (
      profileCandidate &&
      typeof profileCandidate === "object" &&
      !Array.isArray(profileCandidate)
    ) {
      params.cache.set(CACHE_KEYS.KAI_PROFILE(params.userId), profileCandidate, WARM_CACHE_TTL_MS);
    }

    return {
      financialWarmed: true,
      symbols: deriveTrackedSymbols(normalized as Record<string, unknown>),
    };
  }
}
