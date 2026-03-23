"use client";

import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { persistKaiMarketHomePayload } from "@/lib/kai/market-home-cache";
import { getKaiActivePickSource } from "@/lib/kai/pick-source-selection";
import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";

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
    const shouldWarmFinancial =
      warmPriority === "market" ||
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
      shouldWarmFinancial || shouldWarmMetadata
        ? KaiProfileSyncService.syncPendingToVault({
            userId: params.userId,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
          })
        : Promise.resolve({ synced: false, reason: "skipped_for_route" } as const);

    if (warmPriority === "market" && shouldWarmMarket) {
      try {
        const defaultMarketKey = CACHE_KEYS.KAI_MARKET_HOME(
          params.userId,
          "default",
          7,
          activePickSource
        );
        const cachedDefault = cache.get(defaultMarketKey);
        if (cachedDefault) {
          result.kaiMarketWarmed = true;
        } else {
          const kaiHome = await ApiService.getKaiMarketInsights({
            userId: params.userId,
            vaultOwnerToken: params.vaultOwnerToken,
            daysBack: 7,
            pickSource: activePickSource,
          });
          cache.set(defaultMarketKey, kaiHome, WARM_CACHE_TTL_MS);
          persistKaiMarketHomePayload({
            userId: params.userId,
            pickSource: activePickSource,
            payload: kaiHome,
          });
          result.kaiMarketWarmed = true;
        }
      } catch (error) {
        console.warn("[UnlockWarmOrchestrator] Priority market warm-up failed:", error);
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

    if (warmPriority === "market" && shouldWarmMarket && !result.kaiMarketWarmed) {
      try {
        const symbolsKey = toSymbolsKey(symbols);
        const cacheKey = CACHE_KEYS.KAI_MARKET_HOME(
          params.userId,
          symbolsKey,
          7,
          activePickSource
        );
        const cached = cache.get(cacheKey);
        if (cached) {
          result.kaiMarketWarmed = true;
        } else {
          const kaiHome = await ApiService.getKaiMarketInsights({
            userId: params.userId,
            vaultOwnerToken: params.vaultOwnerToken,
            symbols: symbols.length > 0 ? symbols : undefined,
            daysBack: 7,
            pickSource: activePickSource,
          });
          cache.set(cacheKey, kaiHome, WARM_CACHE_TTL_MS);
          if (symbols.length === 0) {
            cache.set(
              CACHE_KEYS.KAI_MARKET_HOME(params.userId, "default", 7, activePickSource),
              kaiHome,
              WARM_CACHE_TTL_MS
            );
          }
          persistKaiMarketHomePayload({
            userId: params.userId,
            pickSource: activePickSource,
            payload: kaiHome,
          });
          result.kaiMarketWarmed = true;
        }
      } catch (error) {
        console.warn("[UnlockWarmOrchestrator] Priority market warm-up failed:", error);
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
      const cachedPicks = cache.get(picksCacheKey);
      if (cachedPicks) {
        result.dashboardPicksWarmed = true;
      } else {
        try {
          const picks = await ApiService.getDashboardProfilePicks({
            userId: params.userId,
            vaultOwnerToken: params.vaultOwnerToken,
            symbols: symbols.length > 0 ? symbols : undefined,
            limit: 3,
          });
          cache.set(picksCacheKey, picks, WARM_CACHE_TTL_MS);
          result.dashboardPicksWarmed = true;
        } catch (error) {
          console.warn("[UnlockWarmOrchestrator] Dashboard picks warm-up failed:", error);
        }
      }
    } else if (shouldWarmDashboardPicks) {
      result.dashboardPicksWarmed = true;
    }

    if (shouldWarmMarket && (!result.kaiMarketWarmed || symbols.length > 0)) {
      const symbolsKey = toSymbolsKey(symbols);
      const cacheKey = CACHE_KEYS.KAI_MARKET_HOME(
        params.userId,
        symbolsKey,
        7,
        activePickSource
      );
      const cached = cache.get(cacheKey);
      if (cached) {
        result.kaiMarketWarmed = true;
        return result;
      }
      try {
        const kaiHome = await ApiService.getKaiMarketInsights({
          userId: params.userId,
          vaultOwnerToken: params.vaultOwnerToken,
          symbols: symbols.length > 0 ? symbols : undefined,
          daysBack: 7,
          pickSource: activePickSource,
        });
        cache.set(cacheKey, kaiHome, WARM_CACHE_TTL_MS);
        if (symbols.length === 0) {
          cache.set(
            CACHE_KEYS.KAI_MARKET_HOME(params.userId, "default", 7, activePickSource),
            kaiHome,
            WARM_CACHE_TTL_MS
          );
        }
        persistKaiMarketHomePayload({
          userId: params.userId,
          pickSource: activePickSource,
          payload: kaiHome,
        });
        result.kaiMarketWarmed = true;
      } catch (error) {
        console.warn("[UnlockWarmOrchestrator] Kai market warm-up failed:", error);
      }
    }

    return result;
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
