"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { KaiFinancialResourceService, useKaiFinancialResource } from "@/lib/kai/kai-financial-resource";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { usMarketRefreshSession, useMarketLiveRefresh } from "@/lib/kai/use-market-live-refresh";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { sanitizeErrorMessage } from "@/lib/services/error-sanitizer";
import { ensureKaiVaultOwnerToken } from "@/lib/services/kai-token-guard";
import type { KaiHomeInsightsV2 } from "@/lib/services/api-service";
import { getKaiActivePickSource, setKaiActivePickSource } from "@/lib/kai/pick-source-selection";

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

export function normalizeMarketSymbol(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeTrackedSymbols(
  symbols: string[] | null | undefined,
): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((symbol) => normalizeMarketSymbol(symbol))
    .filter(Boolean)
    .filter((symbol, index, arr) => arr.indexOf(symbol) === index)
    .slice(0, 8);
}

type KaiMarketLoadOptions = {
  forceTokenRefresh?: boolean;
  manual?: boolean;
  staleOnly?: boolean;
};

function useKaiMarketHomeController() {
  const { userId } = useAuth();
  const {
    vaultKey,
    tokenExpiresAt,
    unlockVault,
    getVaultKey,
    getVaultOwnerToken,
    vaultOwnerToken,
  } = useVault();

  const [activePickSource, setActivePickSource] = useState("default");
  const [pickSourceReady, setPickSourceReady] = useState(false);
  const [financialResourceEnabled, setFinancialResourceEnabled] =
    useState(false);
  const [trackedSymbolsSeed, setTrackedSymbolsSeed] = useState<string[]>([]);
  const serverSeededPickSourceUsersRef = useRef(new Set<string>());
  const backgroundRefreshKeyRef = useRef<string | null>(null);
  const { data: financialResource } = useKaiFinancialResource({
    userId: userId ?? "",
    vaultOwnerToken,
    vaultKey,
    enabled: Boolean(
      userId && vaultKey && vaultOwnerToken && financialResourceEnabled,
    ),
    backgroundRefresh: false,
  });

  useEffect(() => {
    if (!userId) {
      setActivePickSource("default");
      setPickSourceReady(false);
      setFinancialResourceEnabled(false);
      setTrackedSymbolsSeed([]);
      return;
    }
    serverSeededPickSourceUsersRef.current.delete(userId);
    setActivePickSource(getKaiActivePickSource(userId));
    setPickSourceReady(true);
    setFinancialResourceEnabled(false);
    const seededFinancial = normalizeTrackedSymbols(
      KaiFinancialResourceService.peek(userId)?.data?.holdings,
    );
    setTrackedSymbolsSeed(
      seededFinancial.length > 0
        ? seededFinancial
        : normalizeTrackedSymbols(
            KaiMarketHomeResourceService.resolveTrackedSymbols(userId),
          ),
    );
  }, [userId]);

  const trackedSymbols = useMemo(() => {
    if (!userId) {
      return [];
    }
    return trackedSymbolsSeed;
  }, [trackedSymbolsSeed, userId]);

  useEffect(() => {
    if (!userId || trackedSymbolsSeed.length > 0) {
      return;
    }

    const resourceHoldings = normalizeTrackedSymbols(
      financialResource?.holdings,
    );
    if (resourceHoldings.length > 0) {
      setTrackedSymbolsSeed(resourceHoldings);
      return;
    }

    const cacheDerived = normalizeTrackedSymbols(
      KaiMarketHomeResourceService.resolveTrackedSymbols(userId),
    );
    if (cacheDerived.length > 0) {
      setTrackedSymbolsSeed(cacheDerived);
    }
  }, [financialResource?.holdings, trackedSymbolsSeed.length, userId]);

  const resolveToken = useCallback(
    async (forceRefresh = false): Promise<string> => {
      if (!userId) {
        throw new Error("Missing authenticated user");
      }
      const authGeneration = getAuthSessionGeneration();
      let credentialEpoch = snapshotVaultSessionEpoch();
      const assertCurrent = () => {
        if (
          authGeneration !== getAuthSessionGeneration() ||
          credentialEpoch !== snapshotVaultSessionEpoch() ||
          (getVaultKey && getVaultKey() !== vaultKey)
        ) throw new Error("Finance session changed. Please try again.");
      };
      assertCurrent();
      const token = await ensureKaiVaultOwnerToken({
        userId,
        currentToken: getVaultOwnerToken ? getVaultOwnerToken() : vaultOwnerToken,
        currentExpiresAt: tokenExpiresAt,
        forceRefresh,
        onIssued: (issuedToken, expiresAt) => {
          assertCurrent();
          if (
            vaultKey &&
            (issuedToken !== vaultOwnerToken || expiresAt !== tokenExpiresAt)
          ) {
            if (!unlockVault(vaultKey, issuedToken, expiresAt)) {
              throw new Error("Finance session changed. Please try again.");
            }
            credentialEpoch = snapshotVaultSessionEpoch();
          }
        },
      });
      assertCurrent();
      return token;
    },
    [
      getVaultOwnerToken,
      getVaultKey,
      tokenExpiresAt,
      unlockVault,
      userId,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  const personalizedCacheKey = useMemo(
    () =>
      userId && pickSourceReady
        ? CACHE_KEYS.KAI_MARKET_HOME(
            userId,
            toSymbolsKey(trackedSymbols),
            7,
            activePickSource,
          )
        : "kai_market_home_guest",
    [activePickSource, pickSourceReady, trackedSymbols, userId],
  );
  const marketResourceReady = Boolean(userId && pickSourceReady);

  const baselineResource = useStaleResource<KaiHomeInsightsV2 | null>({
    cacheKey: userId
      ? CACHE_KEYS.KAI_MARKET_HOME_BASELINE(userId, 7)
      : "kai_market_home_baseline_guest",
    enabled: Boolean(userId),
    resourceLabel: "kai_market_home_baseline",
    getRequestVersion: () => usMarketRefreshSession() ?? "closed",
    load: async (options) => {
      if (!userId) {
        return null;
      }
      return await KaiMarketHomeResourceService.getBaselineStaleFirst({
        userId,
        daysBack: 7,
        forceRefresh: Boolean(options?.force),
        backgroundRefresh: !options?.force,
      });
    },
  });

  const personalizedResource = useStaleResource<KaiHomeInsightsV2 | null>({
    cacheKey: personalizedCacheKey,
    enabled: marketResourceReady,
    resourceLabel: "kai_market_home",
    getRequestVersion: () => usMarketRefreshSession() ?? "closed",
    load: async (options) => {
      if (!userId) {
        return null;
      }
      const currentToken = getVaultOwnerToken ? getVaultOwnerToken() : vaultOwnerToken ?? null;
      const currentVaultKey = getVaultKey ? getVaultKey() : vaultKey;
      if (options?.force) {
        if (!currentToken && !currentVaultKey) {
          return null;
        }
        const forcedToken =
          currentToken && !currentVaultKey ? currentToken : await resolveToken(false);
        return await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
          userId,
          vaultOwnerToken: forcedToken,
          pickSource: activePickSource,
          symbols: trackedSymbols,
          daysBack: 7,
          forceRefresh: true,
          backgroundRefresh: false,
        });
      }

      const cachedOrDevice =
        await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
          userId,
          vaultOwnerToken: currentToken,
          pickSource: activePickSource,
          symbols: trackedSymbols,
          daysBack: 7,
          forceRefresh: false,
          backgroundRefresh: false,
        });
      if (cachedOrDevice) {
        return cachedOrDevice;
      }
      if (currentToken) {
        return await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
          userId,
          vaultOwnerToken: currentToken,
          pickSource: activePickSource,
          symbols: trackedSymbols,
          daysBack: 7,
          forceRefresh: false,
          backgroundRefresh: true,
        });
      }

      if (!currentVaultKey) {
        return null;
      }
      const token = await resolveToken(false);
      return await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
        userId,
        vaultOwnerToken: token,
        pickSource: activePickSource,
        symbols: trackedSymbols,
        daysBack: 7,
        forceRefresh: false,
        backgroundRefresh: true,
      });
    },
  });
  const baselinePayload = baselineResource.data;
  const personalizedPayload = personalizedResource.data;
  const payload = personalizedPayload ?? baselinePayload;

  useEffect(() => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setFinancialResourceEnabled(false);
      backgroundRefreshKeyRef.current = null;
      return;
    }

    let cancelled = false;
    const hasCachedMarketPayload = Boolean(
      baselineResource.snapshot?.data ||
      baselineResource.data ||
      personalizedResource.snapshot?.data ||
      personalizedResource.data,
    );

    const enable = () => {
      if (!cancelled) {
        setFinancialResourceEnabled(true);
      }
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      const handle = requestIdle(() => enable(), {
        timeout: hasCachedMarketPayload ? 2200 : 1200,
      });
      return () => {
        cancelled = true;
        cancelIdle(handle);
      };
    }

    const timeoutId = globalThis.setTimeout(
      enable,
      hasCachedMarketPayload ? 1400 : 250,
    );
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutId);
    };
  }, [
    baselineResource.data,
    baselineResource.snapshot?.data,
    personalizedResource.data,
    personalizedResource.snapshot?.data,
    userId,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken || !personalizedPayload) {
      return;
    }

    const refreshKey = [
      userId,
      activePickSource,
      toSymbolsKey(trackedSymbols),
    ].join(":");

    if (backgroundRefreshKeyRef.current === refreshKey) {
      return;
    }
    backgroundRefreshKeyRef.current = refreshKey;

    const timeoutId = globalThis.setTimeout(() => {
      void KaiMarketHomeResourceService.refreshPersonalized({
        userId,
        vaultOwnerToken,
        pickSource: activePickSource,
        symbols: trackedSymbols,
        daysBack: 7,
      }).catch(() => undefined);
    }, 1800);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [
    activePickSource,
    personalizedPayload,
    trackedSymbols,
    userId,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    const nextSource = String(
      personalizedPayload?.active_pick_source || "",
    ).trim();
    if (
      !userId ||
      !nextSource ||
      serverSeededPickSourceUsersRef.current.has(userId)
    )
      return;
    const storedSource = getKaiActivePickSource(userId);
    if (storedSource !== "default") {
      serverSeededPickSourceUsersRef.current.add(userId);
      return;
    }
    if (nextSource === activePickSource) {
      serverSeededPickSourceUsersRef.current.add(userId);
      return;
    }
    serverSeededPickSourceUsersRef.current.add(userId);
    setActivePickSource(nextSource);
  }, [activePickSource, personalizedPayload?.active_pick_source, userId]);

  useEffect(() => {
    setKaiActivePickSource(userId, activePickSource);
  }, [activePickSource, userId]);

  useMarketLiveRefresh(async (force) => {
    await Promise.all([
      baselineResource.refresh({ force }),
      marketResourceReady && (vaultOwnerToken || vaultKey)
        ? personalizedResource.refresh({ force })
        : Promise.resolve(),
    ]);
  }, userId ?? null);

  const loadInsights = useCallback(
    async ({
      forceTokenRefresh = false,
      manual = false,
    }: KaiMarketLoadOptions = {}) => {
      if (!userId) {
        return;
      }
      if (forceTokenRefresh && vaultKey) await resolveToken(true);
      const shouldForce = Boolean(forceTokenRefresh || manual);
      await baselineResource.refresh({ force: shouldForce });
      if (marketResourceReady && (vaultOwnerToken || vaultKey)) {
        await personalizedResource.refresh({ force: shouldForce });
      }
    },
    [
      baselineResource,
      marketResourceReady,
      personalizedResource,
      resolveToken,
      userId,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  const handlePickSourceChange = useCallback(
    (nextSource: string) => {
      if (!nextSource || nextSource === activePickSource) return;
      setActivePickSource(nextSource);
    },
    [activePickSource],
  );

  return {
    payload,
    loading: !payload && baselineResource.loading,
    refreshing: baselineResource.refreshing || personalizedResource.refreshing,
    error: sanitizeMarketHomeError(
      payload
        ? personalizedResource.error || baselineResource.error
        : baselineResource.error || personalizedResource.error,
    ),
    activePickSource,
    loadInsights,
    handlePickSourceChange,
  };
}

function sanitizeMarketHomeError(error: string | null): string | null {
  if (!error) return null;
  if (/\b404\b/.test(error) || /not ready yet/i.test(error)) {
    return null;
  }
  return sanitizeErrorMessage(error).message;
}

const MarketHomeContext = createContext<ReturnType<typeof useKaiMarketHomeController> | null>(null);

/** One resource owner for Market and Stocks, including consented personalization. */
export function KaiMarketHomeProvider({ children }: { children: ReactNode }) {
  const value = useKaiMarketHomeController();
  return <MarketHomeContext.Provider value={value}>{children}</MarketHomeContext.Provider>;
}

export function useKaiMarketHome() {
  const value = useContext(MarketHomeContext);
  if (!value) throw new Error("Finance resources require KaiMarketHomeProvider");
  return value;
}
