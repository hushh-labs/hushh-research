"use client";

import { useMemo } from "react";

import type { PortfolioData } from "@/components/kai/types/portfolio";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  buildFinancialDomainSummary,
  getActiveSource as getStoredActiveSource,
  getActiveStatementSnapshotId,
  getPlaidPortfolio,
  getStatementPortfolio,
  getStatementSnapshotOptions,
  isPlaidMirrorStale,
  setActivePlaidSource,
  setActiveStatementSnapshot,
  upsertPlaidSource,
} from "@/lib/kai/brokerage/financial-sources";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  hasPortfolioHoldings,
  resolveAvailableSources,
  resolvePortfolioFreshness,
  type PlaidPortfolioStatusResponse,
  type PortfolioFreshness,
  type PortfolioSource,
  type StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";

const SECURE_RESOURCE_KEY = "kai_financial_resource_v1";
const REQUEST_LABEL = "kai_financial_resource";
const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;

const inflightNetworkLoads = new Map<string, Promise<KaiFinancialResource | null>>();

interface KaiFinancialResourceRequest {
  userId: string;
  vaultOwnerToken?: string | null;
  vaultKey?: string | null;
  initialStatementPortfolio?: PortfolioData | null;
}

interface KaiFinancialResourceAuditMeta {
  cacheTier: "memory" | "device" | "network";
  refreshedAt: string;
  source: "cache" | "secure_cache" | "network";
}

export interface KaiFinancialResource {
  userId: string;
  financialDomain: Record<string, unknown> | null;
  plaidStatus: PlaidPortfolioStatusResponse | null;
  statementPortfolio: PortfolioData | null;
  plaidPortfolio: PortfolioData | null;
  statementSnapshots: StatementSnapshotOption[];
  activeStatementSnapshotId: string | null;
  activeSource: PortfolioSource;
  availableSources: PortfolioSource[];
  activePortfolio: PortfolioData | null;
  freshness: PortfolioFreshness | null;
  hasFinancialData: boolean;
  holdingsCount: number;
  holdings: string[];
  audit: KaiFinancialResourceAuditMeta;
}

function logRequest(stage: string, detail: Record<string, unknown>): void {
  console.info(`[RequestAudit:${REQUEST_LABEL}] ${stage}`, detail);
}

function toFinancialDomain(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickPreferredSource(params: {
  preferred: PortfolioSource | string | null | undefined;
  availableSources: PortfolioSource[];
}): PortfolioSource {
  const preferred = params.preferred;
  if (
    (preferred === "statement" || preferred === "plaid") &&
    params.availableSources.includes(preferred)
  ) {
    return preferred;
  }
  if (params.availableSources.includes("statement")) return "statement";
  if (params.availableSources.includes("plaid")) return "plaid";
  return "statement";
}

function extractHoldings(portfolio: PortfolioData | null | undefined): string[] {
  if (!Array.isArray(portfolio?.holdings)) {
    return [];
  }
  return portfolio.holdings
    .map((holding) => String(holding.symbol || "").trim().toUpperCase())
    .filter(Boolean);
}

function buildResource(params: {
  userId: string;
  financialDomain: Record<string, unknown> | null;
  plaidStatus: PlaidPortfolioStatusResponse | null;
  initialStatementPortfolio?: PortfolioData | null;
  cacheTier: KaiFinancialResourceAuditMeta["cacheTier"];
  source: KaiFinancialResourceAuditMeta["source"];
}): KaiFinancialResource {
  const statementPortfolio =
    getStatementPortfolio(params.financialDomain) ??
    (params.initialStatementPortfolio && hasPortfolioHoldings(params.initialStatementPortfolio)
      ? params.initialStatementPortfolio
      : null);
  const statementSnapshots = getStatementSnapshotOptions(params.financialDomain);
  const activeStatementSnapshotId = getActiveStatementSnapshotId(params.financialDomain);
  const plaidPortfolio =
    getPlaidPortfolio(params.financialDomain) ??
    ((params.plaidStatus?.aggregate?.portfolio_data as PortfolioData | null | undefined) ?? null);
  const availableSources = resolveAvailableSources({
    statementPortfolio,
    plaidPortfolio,
  });
  const storedActiveSource =
    params.plaidStatus?.source_preference ?? getStoredActiveSource(params.financialDomain);
  const hasSavedStatementSnapshot = Boolean(activeStatementSnapshotId);
  const desiredSource: PortfolioSource =
    storedActiveSource === "plaid" ||
    (!hasSavedStatementSnapshot && hasPortfolioHoldings(plaidPortfolio))
      ? "plaid"
      : "statement";
  const activeSource = pickPreferredSource({
    preferred: desiredSource,
    availableSources,
  });
  const activePortfolio = activeSource === "plaid" ? plaidPortfolio : statementPortfolio;
  const hasFinancialData =
    hasPortfolioHoldings(statementPortfolio) ||
    hasPortfolioHoldings(plaidPortfolio) ||
    statementSnapshots.length > 0;
  const holdings = extractHoldings(activePortfolio ?? statementPortfolio ?? plaidPortfolio);

  return {
    userId: params.userId,
    financialDomain: params.financialDomain,
    plaidStatus: params.plaidStatus,
    statementPortfolio,
    plaidPortfolio,
    statementSnapshots,
    activeStatementSnapshotId,
    activeSource,
    availableSources,
    activePortfolio,
    freshness: resolvePortfolioFreshness(params.plaidStatus),
    hasFinancialData,
    holdingsCount: holdings.length,
    holdings,
    audit: {
      cacheTier: params.cacheTier,
      refreshedAt: new Date().toISOString(),
      source: params.source,
    },
  };
}

function primePortfolioCaches(resource: KaiFinancialResource): void {
  const cache = CacheService.getInstance();
  if (resource.statementPortfolio) {
    cache.set(
      CACHE_KEYS.PORTFOLIO_DATA(resource.userId),
      resource.statementPortfolio,
      CACHE_TTL.SESSION
    );
  }
  if (resource.financialDomain) {
    cache.set(
      CACHE_KEYS.DOMAIN_DATA(resource.userId, "financial"),
      resource.financialDomain,
      CACHE_TTL.SESSION
    );
  }
}

async function loadFinancialContext(
  params: KaiFinancialResourceRequest
): Promise<{
  fullBlob: Record<string, unknown>;
  financial: Record<string, unknown> | null;
  expectedDataVersion: number | undefined;
}> {
  const prepared = await PkmDomainResourceService.prepareDomainWriteContext({
    userId: params.userId,
    domain: "financial",
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken || undefined,
  });

  return {
    fullBlob: prepared.baseFullBlob,
    financial: toFinancialDomain(prepared.domainData),
    expectedDataVersion: prepared.expectedDataVersion,
  };
}

async function refreshDerivedMarketCaches(params: KaiFinancialResourceRequest): Promise<void> {
  CacheSyncService.onPlaidSourceProjected(params.userId);
  if (!params.vaultKey || !params.vaultOwnerToken) {
    return;
  }
  await UnlockWarmOrchestrator.run({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    routePath:
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : undefined,
  }).catch(() => undefined);
}

async function loadNetworkResource(
  params: KaiFinancialResourceRequest
): Promise<KaiFinancialResource | null> {
  const [financialContext, loadedPlaidStatus] = await Promise.all([
    loadFinancialContext(params),
    params.vaultOwnerToken
      ? PlaidPortfolioService.getStatus({
          userId: params.userId,
          vaultOwnerToken: params.vaultOwnerToken,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  let nextFinancial = financialContext.financial;
  const storedActiveSource =
    loadedPlaidStatus?.source_preference ?? getStoredActiveSource(nextFinancial);
  const hasSavedStatementSnapshot = Boolean(getActiveStatementSnapshotId(nextFinancial));
  const desiredSource: PortfolioSource =
    storedActiveSource === "plaid" ||
    (!hasSavedStatementSnapshot &&
      hasPortfolioHoldings(loadedPlaidStatus?.aggregate?.portfolio_data))
      ? "plaid"
      : "statement";
  const nowIso = new Date().toISOString();

  if (params.vaultKey && params.vaultOwnerToken) {
    let projectedFinancial = nextFinancial ?? {};
    let shouldPersist = false;

    if (loadedPlaidStatus?.configured && isPlaidMirrorStale(projectedFinancial, loadedPlaidStatus)) {
      projectedFinancial = upsertPlaidSource(
        projectedFinancial,
        loadedPlaidStatus,
        desiredSource === "plaid" ? "plaid" : "statement",
        nowIso
      );
      shouldPersist = true;
    }

    if (desiredSource === "plaid" && getStoredActiveSource(projectedFinancial) !== "plaid") {
      const plaidActivated = setActivePlaidSource(projectedFinancial, loadedPlaidStatus, nowIso);
      if (plaidActivated) {
        projectedFinancial = plaidActivated;
        shouldPersist = true;
      }
    }

    if (desiredSource === "statement" && getStoredActiveSource(projectedFinancial) !== "statement") {
      const activeSnapshotId = getActiveStatementSnapshotId(projectedFinancial);
      if (activeSnapshotId) {
        const statementActivated = setActiveStatementSnapshot(
          projectedFinancial,
          activeSnapshotId,
          nowIso
        );
        if (statementActivated) {
          projectedFinancial = statementActivated;
          shouldPersist = true;
        }
      }
    }

    if (shouldPersist) {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: params.userId,
        domain: "financial",
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        build: () => ({
          domainData: projectedFinancial,
          summary: buildFinancialDomainSummary(projectedFinancial),
        }),
      });
      nextFinancial = toFinancialDomain(result.fullBlob.financial) ?? projectedFinancial;
      await refreshDerivedMarketCaches(params);
    }
  }

  const resource = buildResource({
    userId: params.userId,
    financialDomain: nextFinancial,
    plaidStatus: loadedPlaidStatus,
    initialStatementPortfolio: params.initialStatementPortfolio,
    cacheTier: "network",
    source: "network",
  });

  const cache = CacheService.getInstance();
  cache.set(CACHE_KEYS.KAI_FINANCIAL_RESOURCE(params.userId), resource, CACHE_TTL.SESSION);
  primePortfolioCaches(resource);

  if (params.vaultKey) {
    await SecureResourceCacheService.write({
      userId: params.userId,
      resourceKey: SECURE_RESOURCE_KEY,
      value: resource,
      ttlMs: DEVICE_TTL_MS,
      vaultKey: params.vaultKey,
    });
  }

  return resource;
}

export class KaiFinancialResourceService {
  static peek(userId: string) {
    return CacheService.getInstance().peek<KaiFinancialResource>(
      CACHE_KEYS.KAI_FINANCIAL_RESOURCE(userId)
    );
  }

  static primeFromFinancialDomain(params: {
    userId: string;
    financialDomain: Record<string, unknown> | null;
    initialStatementPortfolio?: PortfolioData | null;
    cacheTier?: KaiFinancialResourceAuditMeta["cacheTier"];
    source?: KaiFinancialResourceAuditMeta["source"];
  }): KaiFinancialResource | null {
    if (!params.financialDomain) {
      return null;
    }

    const resource = buildResource({
      userId: params.userId,
      financialDomain: params.financialDomain,
      plaidStatus: null,
      initialStatementPortfolio: params.initialStatementPortfolio,
      cacheTier: params.cacheTier ?? "memory",
      source: params.source ?? "cache",
    });
    CacheService.getInstance().set(
      CACHE_KEYS.KAI_FINANCIAL_RESOURCE(params.userId),
      resource,
      CACHE_TTL.SESSION
    );
    primePortfolioCaches(resource);
    return resource;
  }

  static async hydrateFromSecureCache(params: {
    userId: string;
    vaultKey?: string | null;
  }): Promise<KaiFinancialResource | null> {
    if (!params.vaultKey) {
      return null;
    }

    const resource = await SecureResourceCacheService.read<KaiFinancialResource>({
      userId: params.userId,
      resourceKey: SECURE_RESOURCE_KEY,
      vaultKey: params.vaultKey,
    });
    if (!resource) {
      logRequest("cache_miss", {
        tier: "device",
        userId: params.userId,
      });
      return null;
    }

    const hydrated: KaiFinancialResource = {
      ...resource,
      audit: {
        cacheTier: "device",
        refreshedAt: new Date().toISOString(),
        source: "secure_cache",
      },
    };
    CacheService.getInstance().set(
      CACHE_KEYS.KAI_FINANCIAL_RESOURCE(params.userId),
      hydrated,
      CACHE_TTL.SESSION
    );
    primePortfolioCaches(hydrated);
    logRequest("cache_hit", {
      tier: "device",
      userId: params.userId,
    });
    return hydrated;
  }

  static async getStaleFirst(
    params: KaiFinancialResourceRequest & {
      forceRefresh?: boolean;
      backgroundRefresh?: boolean;
    }
  ): Promise<KaiFinancialResource | null> {
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.KAI_FINANCIAL_RESOURCE(params.userId);
    const memorySnapshot = cache.peek<KaiFinancialResource>(cacheKey);

    if (!params.forceRefresh && memorySnapshot?.isFresh) {
      logRequest("cache_hit", {
        tier: "memory",
        userId: params.userId,
      });
      return memorySnapshot.data;
    }

    if (!params.forceRefresh && memorySnapshot?.data) {
      logRequest("stale_hit", {
        tier: "memory",
        userId: params.userId,
      });
      if (params.backgroundRefresh !== false) {
        void this.refresh(params);
      }
      return memorySnapshot.data;
    }

    logRequest("cache_miss", {
      tier: "memory",
      userId: params.userId,
    });

    if (!params.forceRefresh) {
      const secure = await this.hydrateFromSecureCache({
        userId: params.userId,
        vaultKey: params.vaultKey,
      });
      if (secure) {
        if (params.backgroundRefresh !== false) {
          void this.refresh(params);
        }
        return secure;
      }

      const financialDomainSnapshot = await PkmDomainResourceService.getStaleFirst({
        userId: params.userId,
        domain: "financial",
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        backgroundRefresh: false,
      }).catch(() => null);

      if (financialDomainSnapshot?.data) {
        const derivedFromDomain = this.primeFromFinancialDomain({
          userId: params.userId,
          financialDomain: financialDomainSnapshot.data,
          initialStatementPortfolio: params.initialStatementPortfolio,
          cacheTier:
            financialDomainSnapshot.audit.cacheTier === "device" ? "device" : "memory",
          source:
            financialDomainSnapshot.audit.source === "secure_cache"
              ? "secure_cache"
              : "cache",
        });
        if (derivedFromDomain) {
          logRequest(
            financialDomainSnapshot.audit.cacheTier === "device" ? "device_hit" : "cache_hit",
            {
              tier:
                financialDomainSnapshot.audit.cacheTier === "device" ? "pkm_domain_device" : "pkm_domain_memory",
              userId: params.userId,
            }
          );
          if (params.backgroundRefresh !== false) {
            void this.refresh(params);
          }
          return derivedFromDomain;
        }
      }
    }

    return await this.refresh(params);
  }

  static async refresh(params: KaiFinancialResourceRequest): Promise<KaiFinancialResource | null> {
    const inflightKey = [
      params.userId,
      params.vaultOwnerToken ? "vault-owner" : "no-token",
      params.vaultKey ? "vault-key" : "no-key",
    ].join(":");
    const existing = inflightNetworkLoads.get(inflightKey);
    if (existing) {
      logRequest("inflight_dedupe_hit", {
        userId: params.userId,
      });
      return await existing;
    }

    logRequest("network_fetch", {
      userId: params.userId,
    });
    const request = loadNetworkResource(params).finally(() => {
      if (inflightNetworkLoads.get(inflightKey) === request) {
        inflightNetworkLoads.delete(inflightKey);
      }
    });
    inflightNetworkLoads.set(inflightKey, request);
    return await request;
  }

  static invalidate(userId: string, options?: { includeDevice?: boolean }): void {
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_FINANCIAL_RESOURCE(userId));
    if (options?.includeDevice) {
      void SecureResourceCacheService.invalidateResource(userId, SECURE_RESOURCE_KEY);
    }
  }
}

export function useKaiFinancialResource(
  params: KaiFinancialResourceRequest & {
    enabled?: boolean;
    backgroundRefresh?: boolean;
  }
) {
  const cacheKey = useMemo(
    () =>
      params.userId
        ? CACHE_KEYS.KAI_FINANCIAL_RESOURCE(params.userId)
        : "kai_financial_resource_disabled",
    [params.userId]
  );
  const refreshKey = useMemo(
    () =>
      [
        params.userId || "no-user",
        params.vaultKey ? "vault-key" : "no-vault-key",
        params.vaultOwnerToken ? "vault-owner-token" : "no-vault-owner-token",
        params.backgroundRefresh === false ? "no-background-refresh" : "background-refresh",
        params.initialStatementPortfolio ? "has-initial-statement-snapshot" : "no-initial-statement-snapshot",
      ].join(":"),
    [
      params.backgroundRefresh,
      params.initialStatementPortfolio,
      params.userId,
      params.vaultKey,
      params.vaultOwnerToken,
    ]
  );

  return useStaleResource<KaiFinancialResource | null>({
    cacheKey,
    enabled: Boolean(params.enabled ?? true) && Boolean(params.userId),
    resourceLabel: REQUEST_LABEL,
    refreshKey,
    load: async () =>
      await KaiFinancialResourceService.getStaleFirst({
        ...params,
        backgroundRefresh: params.backgroundRefresh,
      }),
  });
}
