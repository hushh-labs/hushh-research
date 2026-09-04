"use client";

import { getKaiActivePickSource } from "@/lib/kai/pick-source-selection";
import { preloadTickerUniverse } from "@/lib/kai/ticker-universe-cache";
import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { trackWarmupCompleted } from "@/lib/observability/client";

export type FinanceWorkspaceTab = "market" | "portfolio" | "analysis";

export interface FinanceWorkspaceWarmupInput {
  userId: string;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  activeTab: FinanceWorkspaceTab;
}

type WarmableResource = "market" | "financial" | "ticker_universe";

function normalizeSymbols(symbols: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((symbol) => String(symbol || "").trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol, index, values) => values.indexOf(symbol) === index)
    .slice(0, 8);
}

async function warm<T>(
  resource: WarmableResource,
  input: FinanceWorkspaceWarmupInput,
  load: () => Promise<T>,
): Promise<T | null> {
  const startedAt = Date.now();
  const resourceClass =
    resource === "financial"
      ? "financial_resource"
      : resource === "ticker_universe"
        ? "public_static"
        : "market_data";

  try {
    const result = await load();
    trackWarmupCompleted({
      result: "success",
      resourceClass,
      cacheTier: "memory",
      warmPriority: `finance_workspace:${input.activeTab}`,
      durationMs: Date.now() - startedAt,
      routeId: "kai_home",
    });
    return result;
  } catch {
    trackWarmupCompleted({
      result: "expected_error",
      resourceClass,
      cacheTier: "none",
      warmPriority: `finance_workspace:${input.activeTab}`,
      durationMs: Date.now() - startedAt,
      routeId: "kai_home",
    });
    return null;
  }
}

/**
 * Prime Finance's three query-selected panels without changing tab ownership.
 *
 * Every request uses the existing stale-first, device-aware services. The
 * warmer never forces a refresh, never awaits from navigation, and only warms
 * protected portfolio data after both vault credentials are already available.
 */
export async function warmFinanceWorkspace(
  input: FinanceWorkspaceWarmupInput,
): Promise<void> {
  const userId = String(input.userId || "").trim();
  if (!userId) return;

  const baselineWarm = warm("market", input, () =>
    KaiMarketHomeResourceService.getBaselineStaleFirst({
      userId,
      daysBack: 7,
      backgroundRefresh: true,
    }),
  );
  const tickerUniverseWarm = warm("ticker_universe", input, () =>
    preloadTickerUniverse(),
  );

  const vaultKey = String(input.vaultKey || "").trim();
  const vaultOwnerToken = String(input.vaultOwnerToken || "").trim();
  const cachedSymbols = normalizeSymbols(
    KaiMarketHomeResourceService.resolveTrackedSymbols(userId),
  );
  const financialWarm =
    vaultKey && vaultOwnerToken
      ? warm("financial", input, () =>
          KaiFinancialResourceService.getStaleFirst({
            userId,
            vaultKey,
            vaultOwnerToken,
            backgroundRefresh: true,
          }),
        )
      : Promise.resolve(null);

  const personalizedMarketWarm = financialWarm.then(async (financial) => {
    if (!vaultOwnerToken) return null;
    const symbols = normalizeSymbols(financial?.holdings ?? cachedSymbols);
    if (symbols.length === 0) return null;
    return await warm("market", input, () =>
      KaiMarketHomeResourceService.getPersonalizedStaleFirst({
        userId,
        vaultOwnerToken,
        pickSource: getKaiActivePickSource(userId),
        symbols,
        daysBack: 7,
        backgroundRefresh: true,
      }),
    );
  });

  await Promise.all([
    baselineWarm,
    tickerUniverseWarm,
    financialWarm,
    personalizedMarketWarm,
  ]);
}

/** Schedule non-blocking warmup after a Finance workspace tab becomes visible. */
export function scheduleFinanceWorkspaceWarmup(
  input: FinanceWorkspaceWarmupInput,
): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    void warmFinanceWorkspace(input);
  };

  if (typeof window === "undefined") {
    return () => {
      cancelled = true;
    };
  }

  const requestIdle = window.requestIdleCallback;
  const cancelIdle = window.cancelIdleCallback;
  if (typeof requestIdle === "function" && typeof cancelIdle === "function") {
    const handle = requestIdle(run, { timeout: 750 });
    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  }

  const timeoutId = globalThis.setTimeout(run, 80);
  return () => {
    cancelled = true;
    globalThis.clearTimeout(timeoutId);
  };
}
