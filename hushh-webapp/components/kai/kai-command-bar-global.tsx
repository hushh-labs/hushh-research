"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { KaiSearchBar } from "@/components/kai/kai-search-bar";
import { StockComparisonPreview } from "@/components/kai/cards/stock-comparison-preview";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { ApiService, type KaiStockPreviewResponse } from "@/lib/services/api-service";
import { getKaiActivePickSource } from "@/lib/kai/pick-source-selection";

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function computeAnalyzeEligibilityFromHolding(holding: Record<string, unknown>): boolean {
  const isInvestable = toBoolean(holding.is_investable) === true;
  if (!isInvestable) return false;

  const listingStatus = String(holding.security_listing_status || "")
    .trim()
    .toLowerCase();
  const symbolKind = String(holding.symbol_kind || "")
    .trim()
    .toLowerCase();
  const isSecCommon = toBoolean(holding.is_sec_common_equity_ticker) === true;

  if (listingStatus === "non_sec_common_equity") return false;
  if (listingStatus === "fixed_income") return false;
  if (listingStatus === "cash_or_sweep") return false;

  if (isSecCommon) return true;
  if (listingStatus === "sec_common_equity") return true;
  if (symbolKind === "us_common_equity_ticker") return true;

  return false;
}

export function KaiCommandBarGlobal() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const setAnalysisParams = useKaiSession((s) => s.setAnalysisParams);
  const busyOperations = useKaiSession((s) => s.busyOperations);
  const cache = useMemo(() => CacheService.getInstance(), []);
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [previewSymbol, setPreviewSymbol] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<KaiStockPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const userId = user?.uid ?? "";

  useEffect(() => {
    if (!user?.uid) {
      setHasPortfolioData(false);
      return;
    }

    const computeHasPortfolioFromCache = (): boolean | null => {
      const cachedPortfolio = cache.get<Record<string, unknown>>(
        CACHE_KEYS.PORTFOLIO_DATA(user.uid)
      );
      if (!cachedPortfolio || typeof cachedPortfolio !== "object") {
        return null;
      }
      const nestedPortfolio =
        cachedPortfolio.portfolio &&
        typeof cachedPortfolio.portfolio === "object" &&
        !Array.isArray(cachedPortfolio.portfolio)
          ? (cachedPortfolio.portfolio as Record<string, unknown>)
          : null;
      const holdings = (Array.isArray(cachedPortfolio.holdings) && cachedPortfolio.holdings
        ? cachedPortfolio.holdings
        : Array.isArray(nestedPortfolio?.holdings)
          ? nestedPortfolio.holdings
        : []) as Array<Record<string, unknown>>;
      return holdings.length > 0;
    };

    let cancelled = false;

    const computeHasPortfolio = async () => {
      const cachedHasPortfolio = computeHasPortfolioFromCache();
      if (cachedHasPortfolio !== null) {
        if (!cancelled) {
          setHasPortfolioData(cachedHasPortfolio);
        }
        return;
      }

      if (!isVaultUnlocked || !vaultOwnerToken) {
        if (!cancelled) {
          setHasPortfolioData(false);
        }
        return;
      }

      try {
        const metadata = await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          false,
          vaultOwnerToken
        );
        if (cancelled) return;
        const financialDomain = metadata.domains.find((domain) => domain.key === "financial");
        const hasPortfolioFromMetadata = Boolean(
          financialDomain && Number(financialDomain.attributeCount || 0) > 0
        );

        setHasPortfolioData(hasPortfolioFromMetadata);
      } catch {
        if (!cancelled) {
          setHasPortfolioData(false);
        }
      }
    };

    void computeHasPortfolio();
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "set" || event.type === "invalidate" || event.type === "invalidate_user" || event.type === "clear") {
        void computeHasPortfolio();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [cache, isVaultUnlocked, user?.uid, vaultOwnerToken]);

  const reviewScreenActive = Boolean(
    busyOperations["portfolio_review_active"] || busyOperations["portfolio_save"]
  );
  const reviewDirty = Boolean(
    busyOperations["portfolio_review_active"] && busyOperations["portfolio_review_dirty"]
  );

  const portfolioTickers = useMemo(() => {
    if (!user?.uid) return [] as Array<{
      symbol: string;
      name?: string;
      sector?: string;
      asset_type?: string;
      is_investable?: boolean;
      analyze_eligible?: boolean;
    }>;

    const cachedPortfolio =
      cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(user.uid)) ??
      cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(user.uid, "financial"));
    const nestedPortfolio =
      cachedPortfolio?.portfolio &&
      typeof cachedPortfolio.portfolio === "object" &&
      !Array.isArray(cachedPortfolio.portfolio)
        ? (cachedPortfolio.portfolio as Record<string, unknown>)
        : null;
    const holdings = (
      (Array.isArray(cachedPortfolio?.holdings) && cachedPortfolio.holdings) ||
      (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
      []
    ) as Array<Record<string, unknown>>;

    const deduped = new Map<
      string,
      {
        symbol: string;
        name?: string;
        sector?: string;
        asset_type?: string;
        is_investable?: boolean;
        analyze_eligible?: boolean;
      }
    >();
    for (const holding of holdings) {
      const symbol = String(holding.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      if (deduped.has(symbol)) continue;
      deduped.set(symbol, {
        symbol,
        name: holding.name ? String(holding.name) : undefined,
        sector: holding.sector ? String(holding.sector) : undefined,
        asset_type: holding.asset_type ? String(holding.asset_type) : undefined,
        is_investable: typeof holding.is_investable === "boolean" ? holding.is_investable : undefined,
        analyze_eligible: computeAnalyzeEligibilityFromHolding(holding),
      });
    }
    return Array.from(deduped.values());
  }, [cache, user?.uid]);

  useEffect(() => {
    if (!previewSymbol || !vaultOwnerToken || !userId) {
      setPreviewData(null);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);

    void (async () => {
      try {
        const payload = await ApiService.getKaiStockPreview({
          userId,
          symbol: previewSymbol,
          vaultOwnerToken,
          pickSource: getKaiActivePickSource(userId),
        });
        if (!cancelled) {
          setPreviewData(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewData(null);
          setPreviewError(
            error instanceof Error ? error.message : "Failed to load stock preview"
          );
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewSymbol, userId, vaultOwnerToken]);

  // Command palette is hidden only during loading/review overlays.
  if (loading || !user || reviewScreenActive || !isVaultUnlocked) {
    return null;
  }

  if (chromeState.hideCommandBar) {
    return null;
  }

  const openFullAnalysisForSymbol = (symbol: string) => {
    setPreviewSymbol(null);
    router.push(`${ROUTES.KAI_ANALYSIS}?ticker=${encodeURIComponent(symbol)}`);
  };

  const startDebateForSymbol = (symbol: string) => {
    setPreviewSymbol(null);
    setAnalysisParams({
      ticker: symbol,
      userId,
      riskProfile: "balanced",
    });
    router.push(`${ROUTES.KAI_ANALYSIS}?ticker=${encodeURIComponent(symbol)}`);
  };

  return (
    <>
      <KaiSearchBar
        onCommand={(command, params) => {
          if (
            reviewDirty &&
            !window.confirm(
              "You have unsaved portfolio changes. Leaving now will discard them."
            )
          ) {
            return;
          }

          if (
            !hasPortfolioData &&
            (command === "analyze" || command === "history")
          ) {
            toast.info("Import your portfolio to unlock this command.");
            router.push(ROUTES.KAI_IMPORT);
            return;
          }

          if (command === "analyze" && params?.symbol) {
            if (busyOperations["stock_analysis_active"]) {
              toast.error("A debate is already running.", {
                description: "Open analysis to continue with the active run.",
              });
              router.push(ROUTES.KAI_ANALYSIS);
              return;
            }
            setPreviewSymbol(String(params.symbol).toUpperCase());
            return;
          }

          if (command === "optimize") {
            toast.info("Optimize Portfolio is coming soon.");
            return;
          }

          if (command === "history") {
            router.push(ROUTES.KAI_ANALYSIS);
            return;
          }

          if (command === "dashboard") {
            router.push(ROUTES.KAI_DASHBOARD);
            return;
          }

          if (command === "home") {
            router.push(ROUTES.KAI_HOME);
            return;
          }

          if (command === "consent") {
            router.push(ROUTES.CONSENTS);
            return;
          }

          if (command === "profile") {
            router.push(ROUTES.PROFILE);
          }
        }}
        hasPortfolioData={hasPortfolioData}
        portfolioTickers={portfolioTickers}
      />

      <Dialog open={Boolean(previewSymbol)} onOpenChange={(open) => !open && setPreviewSymbol(null)}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto p-0">
          <DialogTitle className="sr-only">Stock comparison preview</DialogTitle>
          <div className="p-1">
            <StockComparisonPreview
              preview={previewData}
              loading={previewLoading}
              error={previewError}
              onStartDebate={() => previewSymbol && startDebateForSymbol(previewSymbol)}
              onOpenFullAnalysis={() =>
                previewSymbol && openFullAnalysisForSymbol(previewSymbol)
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
