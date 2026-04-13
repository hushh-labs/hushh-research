"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BadgeDollarSign,
  Building2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TrendingDown,
  TrendingUp,
  Loader2,
  Share2,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app-ui/page-sections";
import {
  ChartSurfaceCard,
  FallbackSurfaceCard,
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { AssetAllocationDonut } from "@/components/kai/charts/asset-allocation-donut";
import { GainLossDistributionChart } from "@/components/kai/charts/gain-loss-distribution-chart";
import { HoldingsConcentrationChart } from "@/components/kai/charts/holdings-concentration-chart";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import { SectorAllocationChart } from "@/components/kai/charts/sector-allocation-chart";
import { StatementCashflowChart } from "@/components/kai/charts/statement-cashflow-chart";
import { TransactionActivity } from "@/components/kai/cards/transaction-activity";
import {
  PlaidBrokerageSummarySection,
  PlaidFundingTransfersSection,
} from "@/components/kai/plaid/plaid-brokerage-sections";
import { HoldingRowActions } from "@/components/kai/holdings/holding-row-actions";
import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import type { Holding as PortfolioHolding, PortfolioData } from "@/components/kai/types/portfolio";
import { ProfileBasedPicksList } from "@/components/kai/cards/profile-based-picks-list";
import { useCache, type PortfolioData as CachedPortfolioData } from "@/lib/cache/cache-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon, SegmentedTabs } from "@/lib/morphy-ux/ui";
import { KAI_EXPERIENCE_CONTRACT } from "@/lib/kai/experience-contract";
import { DataTable } from "@/components/app-ui/data-table";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { getTickerUniverseSnapshot, preloadTickerUniverse } from "@/lib/kai/ticker-universe-cache";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildDebateContextFromPortfolio,
  normalizePortfolioTransactions,
  type PlaidItemSummary,
  type PortfolioSource,
} from "@/lib/kai/brokerage/portfolio-sources";
import { usePortfolioSources } from "@/lib/kai/brokerage/use-portfolio-sources";
import { PortfolioSourceSwitcher } from "@/components/kai/portfolio-source-switcher";
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import {
  clearPlaidOAuthResumeSession,
  savePlaidOAuthResumeSession,
} from "@/lib/kai/brokerage/plaid-oauth-session";
import { saveAlpacaOAuthResumeSession } from "@/lib/kai/brokerage/alpaca-oauth-session";
import { resolvePlaidRedirectUri } from "@/lib/kai/brokerage/plaid-redirect-uri";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  buildPortfolioSharePayloadFromDashboardModel,
  exportPortfolioPdf,
} from "@/lib/portfolio-share/client";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";

interface DashboardMasterViewProps {
  userId: string;
  vaultOwnerToken: string;
  portfolioData?: PortfolioData | null;
  onAnalyzeStock?: (
    symbol: string,
    options?: {
      portfolioSource?: PortfolioSource;
      portfolioContext?: Record<string, unknown> | null;
    }
  ) => void;
  onReupload?: () => void;
}

type ManagedHolding = PortfolioHolding & {
  pending_delete?: boolean;
  client_id: string;
  source_key?: string;
};

interface ComparableHolding {
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  market_value: number;
  cost_basis: number;
  acquisition_date: string;
}

type DashboardMainTab = "overview" | "holdings" | "deep-dive";

const ALLOCATION_COLOR_PALETTE = [
  "#2563eb",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
];

const GENERIC_SECTOR_LABELS = new Set([
  "equity",
  "equities",
  "stock",
  "stocks",
  "fixed income",
  "bond",
  "bonds",
  "cash",
  "cash & cash equivalents",
  "other",
  "unknown",
  "unclassified",
]);

function describeTransferDecisionRationale(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const payload = value as Record<string, unknown>;
    const messageCandidates = [
      payload.display_message,
      payload.description,
      payload.message,
      payload.reason,
      payload.rationale,
      payload.code,
    ];
    const message = messageCandidates.find(
      (candidate) => typeof candidate === "string" && candidate.trim().length > 0
    ) as string | undefined;
    if (message) return message.trim();
  }
  return "The funding provider returned a non-approved transfer decision.";
}

const FINANCIAL_INTENT_MAP = [
  "portfolio",
  "profile",
  "documents",
  "analysis_history",
  "runtime",
  "analysis.decisions",
] as const;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatSignedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value))}`;
}

function isDashboardMainTab(value: string): value is DashboardMainTab {
  return value === "overview" || value === "holdings" || value === "deep-dive";
}

function compareHoldingsByNameAsc<T extends { name?: string; symbol?: string }>(
  left: T,
  right: T
): number {
  const leftName = String(left.name || "").trim();
  const rightName = String(right.name || "").trim();
  const leftSymbol = String(left.symbol || "").trim();
  const rightSymbol = String(right.symbol || "").trim();
  const leftKey = leftName || leftSymbol;
  const rightKey = rightName || rightSymbol;

  if (!leftKey && !rightKey) return 0;
  if (!leftKey) return 1;
  if (!rightKey) return -1;

  return leftKey.localeCompare(rightKey, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function deriveRiskBucket(holdings: ManagedHolding[]): string {
  if (!holdings.length) return "unknown";
  const totalValue = holdings.reduce((sum, holding) => sum + (holding.market_value || 0), 0);
  if (totalValue <= 0) return "unknown";
  const largestHolding = holdings
    .slice()
    .sort((a, b) => (b.market_value || 0) - (a.market_value || 0))[0];
  const largestWeight = largestHolding ? ((largestHolding.market_value || 0) / totalValue) * 100 : 0;
  if (largestWeight >= 30) return "aggressive";
  if (largestWeight >= 15) return "moderate";
  return "conservative";
}

function isHoldingAnalyzeEligible(holding: Partial<PortfolioHolding>): boolean {
  if (typeof holding.analyze_eligible === "boolean") {
    return holding.analyze_eligible;
  }
  if (holding.is_investable !== true) return false;
  if (holding.is_cash_equivalent === true) return false;
  const listing = String(holding.security_listing_status || "")
    .trim()
    .toLowerCase();
  const symbolKind = String(holding.symbol_kind || "")
    .trim()
    .toLowerCase();
  const secCommon =
    holding.is_sec_common_equity_ticker === true ||
    listing === "sec_common_equity" ||
    symbolKind === "us_common_equity_ticker";
  if (!secCommon) return false;
  if (
    listing === "non_sec_common_equity" ||
    listing === "fixed_income" ||
    listing === "cash_or_sweep"
  ) {
    return false;
  }
  return true;
}

function isSpecificSectorLabel(value: string | null | undefined): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  return !GENERIC_SECTOR_LABELS.has(text.toLowerCase());
}

function inferEquityTypeFromName(name: string | null | undefined): string | null {
  const hint = String(name || "").trim().toLowerCase();
  if (!hint) return null;
  if (hint.includes("emerging")) return "Emerging Markets Equity";
  if (hint.includes("eafe") || hint.includes("developed")) return "Developed Markets Equity";
  if (hint.includes("small cp")) return "Small Cap U.S. Equity";
  if (hint.includes("small cap")) return "Small Cap U.S. Equity";
  if (hint.includes("mid cp")) return "Mid Cap U.S. Equity";
  if (hint.includes("mid cap")) return "Mid Cap U.S. Equity";
  if (hint.includes("large cp")) return "Large Cap U.S. Equity";
  if (hint.includes("russell 1000") || hint.includes("large cap")) return "Large Cap U.S. Equity";
  if (hint.includes("growth")) return "Growth Equity";
  if (hint.includes("value")) return "Value Equity";
  return null;
}

function resolveEquitySectorLabel({
  holdingSector,
  tickerSector,
  assetType,
  name,
}: {
  holdingSector?: string | null;
  tickerSector?: string | null;
  assetType?: string | null;
  name?: string | null;
}): string {
  if (isSpecificSectorLabel(holdingSector)) return String(holdingSector).trim();
  if (isSpecificSectorLabel(tickerSector)) return String(tickerSector).trim();
  if (isSpecificSectorLabel(assetType)) return String(assetType).trim();
  const inferred = inferEquityTypeFromName(name);
  if (inferred) return inferred;
  return "Other Equity";
}

function classifyNonEquityBucket({
  isCashEquivalent,
  assetBucket,
  holdingSector,
  tickerSector,
  assetType,
  name,
  symbol,
}: {
  isCashEquivalent?: boolean;
  assetBucket?: string | null;
  holdingSector?: string | null;
  tickerSector?: string | null;
  assetType?: string | null;
  name?: string | null;
  symbol?: string | null;
}): string {
  if (isCashEquivalent || String(assetBucket || "").trim().toLowerCase() === "cash_equivalent") {
    return "Cash & Cash Equivalents";
  }
  const bucket = String(assetBucket || "").trim().toLowerCase();
  const hint = `${holdingSector || ""} ${tickerSector || ""} ${assetType || ""} ${name || ""} ${symbol || ""}`
    .toLowerCase();
  if (bucket === "fixed_income") {
    if (
      hint.includes("tax free")
      || hint.includes("municipal")
      || hint.includes("muni")
      || hint.includes("non-taxable")
      || hint.includes("tax-exempt")
    ) {
      return "Fixed Income Tax-Exempt";
    }
    return "Fixed Income Taxable";
  }
  if (bucket === "real_asset") {
    if (hint.includes("gold") || hint.includes("commodity")) {
      return "Commodities";
    }
    return "Real Assets";
  }
  if (hint.includes("gold") || hint.includes("commodity")) {
    return "Commodities";
  }
  if (hint.includes("real estate") || hint.includes("reit")) {
    return "Real Assets";
  }
  return "Other";
}

function toComparableHolding(holding: Partial<PortfolioHolding>): ComparableHolding {
  return {
    symbol: String(holding.symbol || "").trim().toUpperCase(),
    name: String(holding.name || "").trim(),
    quantity: Number.isFinite(Number(holding.quantity)) ? Number(holding.quantity) : 0,
    price: Number.isFinite(Number(holding.price)) ? Number(holding.price) : 0,
    market_value: Number.isFinite(Number(holding.market_value)) ? Number(holding.market_value) : 0,
    cost_basis: Number.isFinite(Number(holding.cost_basis)) ? Number(holding.cost_basis) : 0,
    acquisition_date: String(holding.acquisition_date || "").trim(),
  };
}

function comparableHoldingsEqual(a: ComparableHolding, b: ComparableHolding): boolean {
  return (
    a.symbol === b.symbol &&
    a.name === b.name &&
    Math.abs(a.quantity - b.quantity) < 0.0001 &&
    Math.abs(a.price - b.price) < 0.0001 &&
    Math.abs(a.market_value - b.market_value) < 0.01 &&
    Math.abs(a.cost_basis - b.cost_basis) < 0.01 &&
    a.acquisition_date === b.acquisition_date
  );
}

function createLocalHoldingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local-${crypto.randomUUID()}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildManagedHoldingsFromSource(sourceHoldings: PortfolioHolding[]): {
  managed: ManagedHolding[];
  baselineBySource: Map<string, ComparableHolding>;
} {
  const baselineBySource = new Map<string, ComparableHolding>();
  const managed = sourceHoldings.map((holding, index) => {
    const sourceKey = `source-${index}`;
    baselineBySource.set(sourceKey, toComparableHolding(holding));
    return {
      ...holding,
      pending_delete: false,
      client_id: sourceKey,
      source_key: sourceKey,
    };
  });
  return { managed, baselineBySource };
}

export function DashboardMasterView({
  userId,
  vaultOwnerToken,
  portfolioData,
  onAnalyzeStock,
  onReupload,
}: DashboardMasterViewProps) {
  const router = useRouter();
  const { vaultKey } = useVault();
  const { setPortfolioData: setCachePortfolioData } = useCache();
  const setLosersInput = useKaiSession((s) => s.setLosersInput);
  const baselineBySourceRef = useRef<Map<string, ComparableHolding>>(new Map());
  const {
    isLoading: isSourcesLoading,
    error: sourcesError,
    plaidStatus,
    plaidFundingStatus,
    statementPortfolio,
    statementSnapshots,
    activeStatementSnapshotId,
    activeSource,
    availableSources,
    activePortfolio,
    freshness,
    isPlaidRefreshing,
    changeActiveSource,
    changeActiveStatementSnapshot,
    refreshPlaid,
    cancelPlaidRefresh,
    reload,
  } = usePortfolioSources({
    userId,
    vaultOwnerToken,
    vaultKey,
    initialStatementPortfolio: portfolioData ?? null,
  });

  const [holdingsDraft, setHoldingsDraft] = useState<ManagedHolding[]>([]);
  const [tickerSectorLookup, setTickerSectorLookup] = useState<
    Map<string, { sector?: string; industry?: string }>
  >(() => {
    const rows = getTickerUniverseSnapshot() || [];
    const map = new Map<string, { sector?: string; industry?: string }>();
    for (const row of rows) {
      const ticker = String(row.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      const sector = String(row.sector || row.sector_primary || "").trim() || undefined;
      const industry = String(row.industry || row.industry_primary || "").trim() || undefined;
      if (!sector && !industry) continue;
      map.set(ticker, { sector, industry });
    }
    return map;
  });
  const [isSavingHoldings, setIsSavingHoldings] = useState(false);
  const [isDeletingImportedData, setIsDeletingImportedData] = useState(false);
  const [deleteImportedDialogOpen, setDeleteImportedDialogOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState<ManagedHolding | null>(null);
  const [editingHoldingId, setEditingHoldingId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLinkingPlaid, setIsLinkingPlaid] = useState(false);
  const [isLinkingFunding, setIsLinkingFunding] = useState(false);
  const [isSubmittingTransfer, setIsSubmittingTransfer] = useState(false);
  const [isReconcilingFunding, setIsReconcilingFunding] = useState(false);
  const [isSharingPortfolioPdf, setIsSharingPortfolioPdf] = useState(false);
  const [dashboardMainTab, setDashboardMainTab] = useState<DashboardMainTab>("overview");
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const statementEditablePortfolio = statementPortfolio ?? portfolioData ?? null;
  const canEditStatement = activeSource === "statement" && Boolean(statementEditablePortfolio);
  const displayedPortfolio = activeSource === "statement" ? statementEditablePortfolio : activePortfolio;
  const isPlaidView = activeSource === "plaid";
  const hasPlaidConnections = (plaidStatus?.aggregate?.item_count || 0) > 0;
  const plaidConfigured = plaidStatus?.configured ?? true;

  useEffect(() => {
    const sourceHoldings = (statementEditablePortfolio?.holdings || []) as PortfolioHolding[];
    const { managed, baselineBySource } = buildManagedHoldingsFromSource(sourceHoldings);
    baselineBySourceRef.current = baselineBySource;
    setHoldingsDraft(managed);
  }, [statementEditablePortfolio]);

  useEffect(() => {
    if (activeSource === "statement") return;
    setIsModalOpen(false);
    setEditingHolding(null);
    setEditingHoldingId(null);
  }, [activeSource]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await preloadTickerUniverse();
        if (cancelled) return;
        const map = new Map<string, { sector?: string; industry?: string }>();
        for (const row of rows) {
          const ticker = String(row.ticker || "").trim().toUpperCase();
          if (!ticker) continue;
          const sector = String(row.sector || row.sector_primary || "").trim() || undefined;
          const industry = String(row.industry || row.industry_primary || "").trim() || undefined;
          if (!sector && !industry) continue;
          map.set(ticker, { sector, industry });
        }
        setTickerSectorLookup(map);
      } catch {
        // Keep statement payload values when ticker metadata is unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeHoldings = useMemo(
    () =>
      holdingsDraft
        .filter((holding) => !holding.pending_delete)
        .map((holding) => {
          const {
            pending_delete: _pendingDelete,
            client_id: _clientId,
            source_key: _sourceKey,
            ...rest
          } = holding;
          return rest;
        }),
    [holdingsDraft]
  );

  const holdingsChangeSummary = useMemo(() => {
    const baselineBySource = baselineBySourceRef.current;
    let added = 0;
    let edited = 0;
    let deleted = 0;

    for (const holding of holdingsDraft) {
      const baseline = holding.source_key ? baselineBySource.get(holding.source_key) : undefined;

      if (!baseline) {
        if (!holding.pending_delete) {
          added += 1;
        }
        continue;
      }

      if (holding.pending_delete) {
        deleted += 1;
        continue;
      }

      const currentComparable = toComparableHolding(holding);
      if (!comparableHoldingsEqual(currentComparable, baseline)) {
        edited += 1;
      }
    }

    return {
      added,
      edited,
      deleted,
      total: added + edited + deleted,
    };
  }, [holdingsDraft]);

  const hasHoldingsChanges = holdingsChangeSummary.total > 0;

  const workingPortfolioData = useMemo<PortfolioData>(
    () => {
      const sourcePortfolio = displayedPortfolio ?? statementEditablePortfolio;
      if (!sourcePortfolio) {
        return {
          holdings: [],
          transactions: [],
          cash_balance: 0,
          total_value: 0,
        };
      }

      if (activeSource !== "statement") {
        return sourcePortfolio;
      }

      if (!hasHoldingsChanges) {
        return {
          ...sourcePortfolio,
          holdings: activeHoldings,
        };
      }

      const cashBalance = Number(
        sourcePortfolio.account_summary?.cash_balance ?? sourcePortfolio.cash_balance ?? 0
      );
      const holdingsTotalValue = activeHoldings.reduce(
        (sum, holding) => sum + Number(holding.market_value || 0),
        0
      );
      const holdingsIncludeCash = activeHoldings.some(
        (holding) => holding.is_cash_equivalent === true
      );
      const endingValue = holdingsTotalValue + (holdingsIncludeCash ? 0 : cashBalance);
      const beginningValueRaw = Number(sourcePortfolio.account_summary?.beginning_value);
      const beginningValue = Number.isFinite(beginningValueRaw) ? beginningValueRaw : endingValue;

      return {
        ...sourcePortfolio,
        holdings: activeHoldings,
        total_value: endingValue,
        cash_balance: cashBalance,
        account_summary: {
          ...sourcePortfolio.account_summary,
          ending_value: endingValue,
          cash_balance: cashBalance,
          equities_value: activeHoldings
            .filter((holding) => holding.is_cash_equivalent !== true)
            .reduce((sum, holding) => sum + Number(holding.market_value || 0), 0),
          change_in_value: endingValue - beginningValue,
        },
        ...(hasHoldingsChanges ? { analytics_v2: undefined } : {}),
      };
    },
    [activeHoldings, activeSource, displayedPortfolio, hasHoldingsChanges, statementEditablePortfolio]
  );

  const model = useMemo(
    () => mapPortfolioToDashboardViewModel(workingPortfolioData),
    [workingPortfolioData]
  );
  const portfolioSharePayload = useMemo(
    () => buildPortfolioSharePayloadFromDashboardModel(model),
    [model]
  );
  const hasShareablePortfolioData = useMemo(
    () =>
      portfolioSharePayload.portfolioValue > 0 ||
      portfolioSharePayload.topHoldings.length > 0 ||
      portfolioSharePayload.allocationMix.length > 0 ||
      portfolioSharePayload.sectorAllocation.length > 0 ||
      portfolioSharePayload.performance.length > 0,
    [portfolioSharePayload]
  );

  const workflowPortfolio = activeSource === "statement" ? workingPortfolioData : activePortfolio;
  const workflowPortfolioContext = useMemo(
    () => buildDebateContextFromPortfolio(workflowPortfolio),
    [workflowPortfolio]
  );

  const handleSourceChange = useCallback(
    (nextSource: PortfolioSource) => {
      void changeActiveSource(nextSource).catch((error) => {
        toast.error("Could not switch portfolio source.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      });
    },
    [changeActiveSource]
  );

  const handleRefreshPlaid = useCallback(
    (itemId?: string) => {
      void refreshPlaid(itemId)
        .then((result) => {
          if (result.status === "already_running") {
            toast.info("A refresh is already in progress.", {
              description: "Let it finish or cancel it first.",
              action: result.runIds.length
                ? {
                    label: "Cancel",
                    onClick: () => {
                      void cancelPlaidRefresh({ itemId, runIds: result.runIds });
                    },
                  }
                : undefined,
            });
            return;
          }
          if (result.status !== "started") return;
          toast.message(
            itemId
              ? "Refreshing this brokerage in the background."
              : "Refreshing your brokerage data in the background.",
            {
              description: "We’ll update this portfolio when it finishes.",
              action: {
                label: "Cancel",
                onClick: () => {
                  void cancelPlaidRefresh({ itemId, runIds: result.runIds });
                },
              },
            }
          );
        })
        .catch((error) => {
          toast.error("Could not refresh Plaid.", {
            description: error instanceof Error ? error.message : "Please try again.",
          });
        });
    },
    [cancelPlaidRefresh, refreshPlaid]
  );

  const handleCancelPlaidRefresh = useCallback(
    (params?: { itemId?: string; runIds?: string[] }) => {
      void cancelPlaidRefresh(params)
        .then((result) => {
          if (result.status === "noop") {
            toast.info("No active Plaid refresh is running.");
            return;
          }
          toast.success("Plaid refresh canceled.");
        })
        .catch((error) => {
          toast.error("Could not cancel Plaid refresh.", {
            description: error instanceof Error ? error.message : "Please try again.",
          });
        });
    },
    [cancelPlaidRefresh]
  );

  const handleStatementSnapshotChange = useCallback(
    (snapshotId: string) => {
      void changeActiveStatementSnapshot(snapshotId).catch((error) => {
        toast.error("Could not switch statements.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      });
    },
    [changeActiveStatementSnapshot]
  );

  const openPlaidLinkFlow = useCallback(
    async (itemId?: string) => {
      if (!vaultOwnerToken) {
        toast.error("Please unlock your Vault and try again.");
        return;
      }

      setIsLinkingPlaid(true);
      try {
        const redirectUri = resolvePlaidRedirectUri();
        const linkToken = await PlaidPortfolioService.createLinkToken({
          userId,
          vaultOwnerToken,
          itemId,
          updateMode: Boolean(itemId),
          redirectUri,
        });
        if (!linkToken.configured || !linkToken.link_token) {
          throw new Error("Plaid is not configured for this environment.");
        }
        if (linkToken.resume_session_id) {
          savePlaidOAuthResumeSession({
            version: 1,
            userId,
            resumeSessionId: linkToken.resume_session_id,
            returnPath: ROUTES.KAI_PORTFOLIO,
            startedAt: new Date().toISOString(),
          });
        }

        const Plaid = await loadPlaidLink();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
          };

          const handler = Plaid.create({
            token: linkToken.link_token,
            onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
              void PlaidPortfolioService.exchangePublicToken({
                userId,
                publicToken,
                vaultOwnerToken,
                metadata,
                resumeSessionId: linkToken.resume_session_id || null,
              })
                .then(async () => {
                  clearPlaidOAuthResumeSession();
                  await reload();
                  toast.success(itemId ? "Plaid connection updated." : "Brokerage connected with Plaid.");
                  finish(resolve);
                })
                .catch((error) => {
                  finish(() =>
                    reject(
                      error instanceof Error ? error : new Error("Plaid connection failed.")
                    )
                  );
                })
                .finally(() => {
                  handler.destroy?.();
                });
            },
            onExit: (exitError: Record<string, unknown> | null) => {
              handler.destroy?.();
              clearPlaidOAuthResumeSession();
              if (exitError && typeof exitError === "object") {
                const detail =
                  typeof exitError.error_message === "string"
                    ? exitError.error_message
                    : "Plaid Link closed with an error.";
                finish(() => reject(new Error(detail)));
                return;
              }
              finish(resolve);
            },
          });

          handler.open();
        });
      } catch (error) {
        clearPlaidOAuthResumeSession();
        toast.error(itemId ? "Could not update this Plaid connection." : "Could not start Plaid.", {
          description:
            error instanceof Error
              ? error.message
              : "Kai could not start the brokerage connection flow. Please try again.",
        });
      } finally {
        setIsLinkingPlaid(false);
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const openPlaidFundingLinkFlow = useCallback(
    async (itemId?: string) => {
      if (!vaultOwnerToken) {
        toast.error("Please unlock your Vault and try again.");
        return;
      }

      setIsLinkingFunding(true);
      try {
        const redirectUri = resolvePlaidRedirectUri();
        const linkToken = await PlaidPortfolioService.createFundingLinkToken({
          userId,
          vaultOwnerToken,
          itemId,
          redirectUri,
        });
        if (!linkToken.configured || !linkToken.link_token) {
          throw new Error("Plaid is not configured for this environment.");
        }
        if (linkToken.resume_session_id) {
          savePlaidOAuthResumeSession({
            version: 1,
            flowKind: "funding",
            userId,
            resumeSessionId: linkToken.resume_session_id,
            returnPath: ROUTES.KAI_PORTFOLIO,
            startedAt: new Date().toISOString(),
          });
        }

        const Plaid = await loadPlaidLink();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
          };

          const handler = Plaid.create({
            token: linkToken.link_token,
            onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
              void PlaidPortfolioService.exchangeFundingPublicToken({
                userId,
                publicToken,
                vaultOwnerToken,
                metadata,
                resumeSessionId: linkToken.resume_session_id || null,
                consentTimestamp: new Date().toISOString(),
              })
                .then(async () => {
                  clearPlaidOAuthResumeSession();
                  await reload();
                  toast.success("Funding account connected.");
                  finish(resolve);
                })
                .catch((error) => {
                  finish(() =>
                    reject(error instanceof Error ? error : new Error("Funding connection failed."))
                  );
                })
                .finally(() => {
                  handler.destroy?.();
                });
            },
            onExit: (exitError: Record<string, unknown> | null) => {
              handler.destroy?.();
              clearPlaidOAuthResumeSession();
              if (exitError && typeof exitError === "object") {
                const detail =
                  typeof exitError.error_message === "string"
                    ? exitError.error_message
                    : "Plaid Link closed with an error.";
                finish(() => reject(new Error(detail)));
                return;
              }
              finish(resolve);
            },
          });

          handler.open();
        });
      } catch (error) {
        clearPlaidOAuthResumeSession();
        toast.error("Could not start funding account linking.", {
          description:
            error instanceof Error
              ? error.message
              : "Kai could not start the funding account connection flow. Please try again.",
        });
      } finally {
        setIsLinkingFunding(false);
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleConnectFundingBrokerage = useCallback(async () => {
    if (!vaultOwnerToken) {
      toast.error("Please unlock your Vault and try again.");
      return;
    }

    try {
      await PlaidPortfolioService.setFundingBrokerageAccount({
        userId,
        vaultOwnerToken,
        setDefault: true,
      });
      await reload();
      toast.success("Brokerage funding destination is ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again.";
      const shouldStartOAuth =
        /No Alpaca brokerage account is configured/i.test(message) ||
        /ALPACA_ACCOUNT_REQUIRED/i.test(message);

      if (!shouldStartOAuth) {
        toast.error("Could not prepare brokerage funding destination.", {
          description: message,
        });
        return;
      }

      try {
        const connect = await PlaidPortfolioService.startAlpacaConnect({
          userId,
          vaultOwnerToken,
        });
        if (!connect.authorization_url || !connect.state) {
          throw new Error("Alpaca OAuth is not configured for this environment.");
        }
        saveAlpacaOAuthResumeSession({
          version: 1,
          userId,
          state: connect.state,
          returnPath: ROUTES.KAI_PORTFOLIO,
          startedAt: new Date().toISOString(),
        });
        window.location.assign(connect.authorization_url);
      } catch (oauthError) {
        toast.error("Could not start Alpaca login.", {
          description:
            oauthError instanceof Error ? oauthError.message : "Please try again.",
        });
      }
    }
  }, [reload, userId, vaultOwnerToken]);

  const handleCreateFundingTransfer = useCallback(
    async (payload: {
      fundingItemId: string;
      fundingAccountId: string;
      brokerageItemId?: string | null;
      brokerageAccountId?: string | null;
      amount: number;
      userLegalName: string;
      direction: "to_brokerage" | "from_brokerage";
      idempotencyKey: string;
    }) => {
      if (!vaultOwnerToken) {
        toast.error("Please unlock your Vault and try again.");
        return;
      }
      setIsSubmittingTransfer(true);
      try {
        const redirectUri = resolvePlaidRedirectUri();
        const response = await PlaidPortfolioService.createTransfer({
          userId,
          vaultOwnerToken,
          fundingItemId: payload.fundingItemId,
          fundingAccountId: payload.fundingAccountId,
          amount: payload.amount,
          userLegalName: payload.userLegalName,
          direction: payload.direction,
          idempotencyKey: payload.idempotencyKey,
          brokerageItemId: payload.brokerageItemId || null,
          brokerageAccountId: payload.brokerageAccountId || null,
          redirectUri,
        });
        if (!response.approved) {
          if (response.decision === "user_action_required" && response.action_link_token?.link_token) {
            const actionLink = response.action_link_token;
            if (actionLink.resume_session_id) {
              savePlaidOAuthResumeSession({
                version: 1,
                flowKind: "funding",
                userId,
                resumeSessionId: actionLink.resume_session_id,
                returnPath: ROUTES.KAI_PORTFOLIO,
                startedAt: new Date().toISOString(),
              });
            }
            const Plaid = await loadPlaidLink();
            await new Promise<void>((resolve, reject) => {
              const handler = Plaid.create({
                token: actionLink.link_token!,
                onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
                  void PlaidPortfolioService.exchangeFundingPublicToken({
                    userId,
                    publicToken,
                    vaultOwnerToken,
                    metadata,
                    resumeSessionId: actionLink.resume_session_id || null,
                    consentTimestamp: new Date().toISOString(),
                  })
                    .then(() => resolve())
                    .catch((err) => reject(err))
                    .finally(() => handler.destroy?.());
                },
                onExit: () => {
                  handler.destroy?.();
                  resolve();
                },
              });
              handler.open();
            });
            toast.info("Funding account relink completed. Please try the transfer again.");
          } else {
            toast.error("Transfer was not approved.", {
              description: describeTransferDecisionRationale(response.decision_rationale),
            });
          }
          await reload();
          return;
        }
        toast.success("Transfer submitted.");
        await reload();
      } catch (error) {
        toast.error("Transfer could not be created.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setIsSubmittingTransfer(false);
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleRefreshTransfer = useCallback(
    async (transferId: string) => {
      if (!vaultOwnerToken) return;
      try {
        await PlaidPortfolioService.refreshFundingTransferStatus({
          userId,
          transferId,
          vaultOwnerToken,
        });
        await reload();
      } catch (error) {
        toast.error("Could not refresh transfer status.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleSetDefaultFundingAccount = useCallback(
    async (payload: { itemId: string; accountId: string }) => {
      if (!vaultOwnerToken) return;
      try {
        await PlaidPortfolioService.setDefaultFundingAccount({
          userId,
          itemId: payload.itemId,
          accountId: payload.accountId,
          vaultOwnerToken,
        });
        await reload();
      } catch (error) {
        toast.error("Could not update default funding account.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleRunFundingReconciliation = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setIsReconcilingFunding(true);
    try {
      await PlaidPortfolioService.runFundingReconciliation({
        userId,
        vaultOwnerToken,
        triggerSource: "dashboard_ui",
      });
      toast.success("Funding reconciliation completed.");
      await reload();
    } catch (error) {
      toast.error("Funding reconciliation failed.", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsReconcilingFunding(false);
    }
  }, [reload, userId, vaultOwnerToken]);

  const handleCancelTransfer = useCallback(
    async (transferId: string) => {
      if (!vaultOwnerToken) return;
      try {
        await PlaidPortfolioService.cancelTransfer({
          userId,
          transferId,
          vaultOwnerToken,
        });
        toast.success("Transfer cancellation requested.");
        await reload();
      } catch (error) {
        toast.error("Could not cancel transfer.", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [reload, userId, vaultOwnerToken]
  );

  const handleSearchFundingRecords = useCallback(
    async (payload: {
      transferId?: string;
      relationshipId?: string;
      limit?: number;
    }) => {
      if (!vaultOwnerToken) {
        throw new Error("Please unlock your Vault and try again.");
      }
      return await PlaidPortfolioService.searchFundingRecords({
        userId,
        vaultOwnerToken,
        transferId: payload.transferId || null,
        relationshipId: payload.relationshipId || null,
        limit: payload.limit,
      });
    },
    [userId, vaultOwnerToken]
  );

  const handleCreateFundingEscalation = useCallback(
    async (payload: {
      transferId?: string;
      relationshipId?: string;
      severity: "low" | "normal" | "high" | "urgent";
      notes: string;
    }) => {
      if (!vaultOwnerToken) {
        throw new Error("Please unlock your Vault and try again.");
      }
      await PlaidPortfolioService.createFundingEscalation({
        userId,
        vaultOwnerToken,
        transferId: payload.transferId || null,
        relationshipId: payload.relationshipId || null,
        severity: payload.severity,
        notes: payload.notes,
      });
      toast.success("Support escalation created.");
    },
    [userId, vaultOwnerToken]
  );

  const handleAnalyzeFromDashboard = useCallback(
    (symbol: string) => {
      onAnalyzeStock?.(symbol, {
        portfolioSource: activeSource,
        portfolioContext: workflowPortfolioContext,
      });
    },
    [activeSource, onAnalyzeStock, workflowPortfolioContext]
  );

  const handleOptimizePortfolio = useCallback(() => {
    if (!workflowPortfolio || !Array.isArray(workflowPortfolio.holdings) || workflowPortfolio.holdings.length === 0) {
      toast.error("No holdings available for optimization.");
      return;
    }

    const holdings = workflowPortfolio.holdings.map((holding) => ({
      symbol: String(holding.symbol || "").trim().toUpperCase(),
      name: holding.name,
      gain_loss_pct:
        typeof holding.unrealized_gain_loss_pct === "number"
          ? holding.unrealized_gain_loss_pct
          : undefined,
      gain_loss:
        typeof holding.unrealized_gain_loss === "number"
          ? holding.unrealized_gain_loss
          : undefined,
      market_value:
        typeof holding.market_value === "number" ? holding.market_value : undefined,
      weight_pct:
        typeof holding.weight_pct === "number" ? holding.weight_pct : undefined,
      sector: holding.sector,
      asset_type: holding.asset_type,
    }));
    const losers = holdings.filter((holding) => typeof holding.gain_loss_pct === "number" && holding.gain_loss_pct < 0);

    setLosersInput({
      userId,
      thresholdPct: -5,
      maxPositions: 10,
      losers,
      holdings,
      forceOptimize: losers.length === 0,
      hadBelowThreshold: losers.length > 0,
      portfolioSource: activeSource,
      portfolioContext: workflowPortfolioContext,
      sourceMetadata:
        workflowPortfolio.source_metadata && typeof workflowPortfolio.source_metadata === "object"
          ? workflowPortfolio.source_metadata
          : null,
    });
    router.push(ROUTES.KAI_OPTIMIZE);
  }, [activeSource, router, setLosersInput, userId, workflowPortfolio, workflowPortfolioContext]);

  const allocationData = useMemo(
    () =>
      model.allocation.map((entry, index) => ({
        ...entry,
        color: ALLOCATION_COLOR_PALETTE[index % ALLOCATION_COLOR_PALETTE.length] ?? "#2563eb",
      })),
    [model.allocation]
  );

  const holdingSymbols = useMemo(
    () => model.canonicalModel.debateContext.eligibleSymbols.slice(0, 20),
    [model.canonicalModel.debateContext.eligibleSymbols]
  );
  const recentTransactions = useMemo(
    () => normalizePortfolioTransactions(workingPortfolioData).slice(0, 8),
    [workingPortfolioData]
  );

  const sortedHoldingsDraft = useMemo(
    () => [...holdingsDraft].sort(compareHoldingsByNameAsc),
    [holdingsDraft]
  );

  const sourceHoldingRows = useMemo<ManagedHolding[]>(
    () => {
      if (activeSource === "statement") {
        return sortedHoldingsDraft;
      }
      const holdings = (displayedPortfolio?.holdings || []) as PortfolioHolding[];
      return [...holdings]
        .sort(compareHoldingsByNameAsc)
        .map((holding, index) => ({
          ...holding,
          pending_delete: false,
          client_id: `readonly-${activeSource}-${index}`,
        }));
    },
    [activeSource, displayedPortfolio, sortedHoldingsDraft]
  );

  const holdingsBifurcation = useMemo(() => {
    let cashSweep = 0;
    let analyzeEligible = 0;
    let nonAnalyzable = 0;
    for (const holding of sourceHoldingRows) {
      if (holding.pending_delete) continue;
      if (holding.is_cash_equivalent === true) {
        cashSweep += 1;
        continue;
      }
      if (isHoldingAnalyzeEligible(holding)) {
        analyzeEligible += 1;
      } else {
        nonAnalyzable += 1;
      }
    }
    return { cashSweep, analyzeEligible, nonAnalyzable };
  }, [sourceHoldingRows]);

  const investorSnapshot = useMemo(() => {
    const totalValue = model.hero.totalValue || 0;
    const holdings = model.canonicalModel.positions.filter((position) => position.debateEligible);
    const losers = holdings.filter((holding) => (holding.gainLoss || 0) < 0);
    const losersValue = losers.reduce((sum, holding) => sum + (holding.marketValue || 0), 0);
    const winnersCount = holdings.filter((holding) => (holding.gainLoss || 0) > 0).length;
    const uniqueSectors = new Set(
      holdings
        .map((holding) => String(holding.sector || holding.assetType || "").trim())
        .filter((value) => value.length > 0)
    ).size;
    const top3ConcentrationPct =
      totalValue > 0
        ? model.concentration
            .slice(0, 3)
            .reduce((sum, row) => sum + row.weightPct, 0)
        : 0;
    const cashRow = model.allocation.find((row) => row.name.toLowerCase().includes("cash"));
    const fixedIncomeRow = model.allocation.find(
      (row) =>
        row.name.toLowerCase().includes("fixed income") ||
        row.name.toLowerCase().includes("bond")
    );
    const realAssetsRow = model.allocation.find(
      (row) =>
        row.name.toLowerCase().includes("real asset") ||
        row.name.toLowerCase().includes("real estate") ||
        row.name.toLowerCase().includes("commod")
    );
    const estimatedAnnualIncome = holdings.reduce(
      (sum, holding) => sum + (holding.estimatedAnnualIncome || 0),
      0
    );
    const annualYieldPct =
      totalValue > 0 && estimatedAnnualIncome > 0
        ? (estimatedAnnualIncome / totalValue) * 100
        : 0;
    const optimizationPressurePct = totalValue > 0 ? (losersValue / totalValue) * 100 : 0;
    const readinessScore = Math.round(
      ((model.quality.sectorCoveragePct +
        model.quality.gainLossCoveragePct +
        (model.quality.allocationReady ? 1 : 0) +
        (model.quality.concentrationReady ? 1 : 0)) /
        4) *
        100
    );

    return {
      losersCount: losers.length,
      winnersCount,
      uniqueSectors,
      top3ConcentrationPct,
      cashPct: totalValue > 0 && cashRow ? (cashRow.value / totalValue) * 100 : 0,
      fixedIncomePct: totalValue > 0 && fixedIncomeRow ? (fixedIncomeRow.value / totalValue) * 100 : 0,
      realAssetsPct: totalValue > 0 && realAssetsRow ? (realAssetsRow.value / totalValue) * 100 : 0,
      estimatedAnnualIncome,
      annualYieldPct,
      optimizationPressurePct,
      readinessScore,
    };
  }, [model]);

  const equitySectorChartHoldings = useMemo(
    () =>
      model.canonicalModel.positions
        .filter((position) => !position.isCashEquivalent && position.assetBucket === "equity")
        .map((position) => {
          const enriched = tickerSectorLookup.get(
            String(position.displaySymbol || "").trim().toUpperCase()
          );
          return {
            symbol: position.displaySymbol,
            name: position.name,
            market_value: position.marketValue,
            sector: resolveEquitySectorLabel({
              holdingSector: position.sector,
              tickerSector: enriched?.sector,
              assetType: position.assetType,
              name: position.name,
            }),
            asset_type: position.assetType || undefined,
          };
        }),
    [model.canonicalModel.positions, tickerSectorLookup]
  );

  const nonEquityAllocationChartHoldings = useMemo(
    () =>
      model.canonicalModel.positions
        .filter((position) => position.isCashEquivalent || position.assetBucket !== "equity")
        .map((position) => {
          const enriched = tickerSectorLookup.get(
            String(position.displaySymbol || "").trim().toUpperCase()
          );
          return {
            symbol: position.displaySymbol,
            name: position.name,
            market_value: position.marketValue,
            sector: classifyNonEquityBucket({
              isCashEquivalent: position.isCashEquivalent,
              assetBucket: position.assetBucket,
              holdingSector: position.sector,
              tickerSector: enriched?.sector,
              assetType: position.assetType,
              name: position.name,
              symbol: position.displaySymbol,
            }),
            asset_type: position.assetType || undefined,
          };
        }),
    [model.canonicalModel.positions, tickerSectorLookup]
  );

  const equitySectorCoveragePct = useMemo(() => {
    const equityPositions = model.canonicalModel.positions.filter(
      (position) => !position.isCashEquivalent && position.assetBucket === "equity"
    );
    if (equityPositions.length === 0) return 1;
    const covered = equityPositions.filter((position) => {
      const enriched = tickerSectorLookup.get(
        String(position.displaySymbol || "").trim().toUpperCase()
      );
      return (
        isSpecificSectorLabel(position.sector)
        || isSpecificSectorLabel(enriched?.sector)
        || isSpecificSectorLabel(position.assetType)
        || Boolean(inferEquityTypeFromName(position.name))
      );
    }).length;
    return covered / equityPositions.length;
  }, [model.canonicalModel.positions, tickerSectorLookup]);

  const nonEquityCoveragePct = useMemo(() => {
    const nonEquityPositions = model.canonicalModel.positions.filter(
      (position) => position.isCashEquivalent || position.assetBucket !== "equity"
    );
    if (nonEquityPositions.length === 0) return 1;
    return 1;
  }, [model.canonicalModel.positions]);

  const hasEquitySectorAllocation = equitySectorChartHoldings.length > 0;
  const hasNonEquityAllocation = nonEquityAllocationChartHoldings.length > 0;

  const statementSnapshotRows = useMemo(() => {
    const metrics = model.summaryMetrics;
    return [
      {
        key: "investment-results",
        label: "Investment Results",
        value: metrics.investmentGainLoss,
      },
      {
        key: "income-period",
        label: "Income (Period)",
        value: metrics.totalIncomePeriod,
      },
      {
        key: "income-ytd",
        label: "Income (YTD)",
        value: metrics.totalIncomeYtd,
      },
      {
        key: "fees",
        label: "Fees",
        value: metrics.totalFees,
      },
      {
        key: "net-deposits-period",
        label: "Net Deposits (Period)",
        value: metrics.netDepositsPeriod,
      },
      {
        key: "net-deposits-ytd",
        label: "Net Deposits (YTD)",
        value: metrics.netDepositsYtd,
      },
    ].filter((row) => typeof row.value === "number");
  }, [model.summaryMetrics]);

  const statementChartData = useMemo(
    () =>
      statementSnapshotRows.map((row) => ({
        key: row.key,
        label: row.label.replace(" (Period)", "").replace(" (YTD)", " YTD"),
        value: Number(row.value || 0),
        tone:
          row.key === "fees"
            ? ("negative" as const)
            : row.key === "investment-results" && Number(row.value || 0) < 0
              ? ("negative" as const)
              : row.key.includes("income") || row.key === "investment-results"
                ? ("positive" as const)
                : ("neutral" as const),
      })),
    [statementSnapshotRows]
  );

  const closeHoldingModal = useCallback(() => {
    setIsModalOpen(false);
    setEditingHolding(null);
    setEditingHoldingId(null);
  }, []);

  const openAddHoldingModal = useCallback(() => {
    if (!canEditStatement) {
      toast.info("Plaid holdings are read-only in Kai.");
      return;
    }
    setEditingHolding({
      symbol: "",
      name: "",
      quantity: 0,
      price: 0,
      market_value: 0,
      pending_delete: false,
      client_id: createLocalHoldingId(),
    });
    setEditingHoldingId(null);
    setIsModalOpen(true);
  }, [canEditStatement]);

  const persistHoldingsChanges = useCallback(async () => {
    if (!userId || !vaultKey || !statementEditablePortfolio) {
      toast.error("Unlock your Vault to save holdings.");
      return;
    }

    const invalidHolding = activeHoldings.find((holding) => {
      const quantity = Number(holding.quantity);
      const price = Number(holding.price);
      const marketValue = Number(holding.market_value);
      return (
        !Number.isFinite(quantity) ||
        !Number.isFinite(price) ||
        !Number.isFinite(marketValue) ||
        quantity <= 0 ||
        price <= 0 ||
        marketValue <= 0
      );
    });
    if (invalidHolding) {
      toast.error(
        `Holding ${invalidHolding.symbol || invalidHolding.name || "entry"} has invalid values. Quantity, price, and market value must be greater than 0.`
      );
      return;
    }

    setIsSavingHoldings(true);
    try {
      const holdingsForSave = activeHoldings;
      const cashBalance = Number(
        statementEditablePortfolio.account_summary?.cash_balance ?? statementEditablePortfolio.cash_balance ?? 0
      );
      const holdingsTotalValue = holdingsForSave.reduce(
        (sum, holding) => sum + Number(holding.market_value || 0),
        0
      );
      const holdingsIncludeCash = holdingsForSave.some(
        (holding) => holding.is_cash_equivalent === true
      );
      const endingValue = holdingsTotalValue + (holdingsIncludeCash ? 0 : cashBalance);
      const beginningValueRaw = Number(statementEditablePortfolio.account_summary?.beginning_value);
      const beginningValue = Number.isFinite(beginningValueRaw) ? beginningValueRaw : endingValue;
      const equitiesValue = holdingsForSave
        .filter((holding) => holding.is_cash_equivalent !== true)
        .reduce((sum, holding) => sum + Number(holding.market_value || 0), 0);

      const updatedPortfolioData: PortfolioData = {
        ...statementEditablePortfolio,
        holdings: holdingsForSave,
        account_summary: {
          ...statementEditablePortfolio.account_summary,
          ending_value: endingValue,
          equities_value: equitiesValue,
          cash_balance: cashBalance,
          change_in_value: endingValue - beginningValue,
        },
        total_value: endingValue,
        cash_balance: cashBalance,
      };

      const nowIso = new Date().toISOString();
      const riskBucket = deriveRiskBucket(holdingsForSave as ManagedHolding[]);
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken: vaultOwnerToken || undefined,
        build: (context) => {
          const existingFinancial =
            (context.currentDomainData as Record<string, unknown> | null) ?? {};
          const nextFinancialDomain = {
            ...existingFinancial,
            schema_version: 3,
            domain_intent: {
              primary: "financial",
              source: "domain_registry_prepopulate",
              contract_version: 2,
              updated_at: nowIso,
            },
            portfolio: {
              ...updatedPortfolioData,
              domain_intent: {
                primary: "financial",
                secondary: "portfolio",
                source: "kai_dashboard_holdings",
                captured_sections: ["account_info", "account_summary", "holdings", "transactions"],
                updated_at: nowIso,
              },
            },
            updated_at: nowIso,
          };

          return {
            domainData: nextFinancialDomain as unknown as Record<string, unknown>,
            summary: {
              intent_source: "kai_dashboard_holdings",
              has_portfolio: true,
              holdings_count: holdingsForSave.length,
              last_statement_total_value: endingValue,
              portfolio_risk_bucket: riskBucket,
              risk_bucket: riskBucket,
              domain_contract_version: 2,
              intent_map: [...FINANCIAL_INTENT_MAP],
              last_updated: nowIso,
            },
          };
        },
      });

      if (!result.success) {
        throw new Error("Failed to save holdings");
      }

      setCachePortfolioData(userId, updatedPortfolioData as CachedPortfolioData);
      CacheSyncService.onPortfolioUpserted(userId, updatedPortfolioData as CachedPortfolioData);
      void reload();
      const { managed, baselineBySource } = buildManagedHoldingsFromSource(holdingsForSave);
      baselineBySourceRef.current = baselineBySource;
      setHoldingsDraft(managed);
      toast.success("Holdings updated");
    } catch (error) {
      console.error("[DashboardMasterView] Failed to save holdings:", error);
      toast.error("We could not save your holdings. Please try again.");
    } finally {
      setIsSavingHoldings(false);
    }
  }, [
    activeHoldings,
    reload,
    setCachePortfolioData,
    statementEditablePortfolio,
    userId,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handleDeleteImportedData = useCallback(async () => {
    if (!userId || !vaultKey || !statementEditablePortfolio) {
      toast.error("Unlock your Vault to delete imported data.");
      return;
    }

    setIsDeletingImportedData(true);
    try {
      const nowIso = new Date().toISOString();
      const clearedPortfolioData: PortfolioData = {
        account_info: statementEditablePortfolio.account_info,
        account_summary: {
          beginning_value: 0,
          ending_value: 0,
          change_in_value: 0,
          cash_balance: 0,
          equities_value: 0,
        },
        holdings: [],
        transactions: [],
        asset_allocation: {
          cash_percent: 0,
          equities_percent: 0,
          bonds_percent: 0,
          other_percent: 0,
          cash_value: 0,
          equities_value: 0,
          bonds_value: 0,
          other_value: 0,
        },
        income_summary: {
          dividends_taxable: 0,
          interest_income: 0,
          total_income: 0,
        },
        realized_gain_loss: {
          short_term_gain: 0,
          long_term_gain: 0,
          net_realized: 0,
        },
        cash_balance: 0,
        total_value: 0,
      };

      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken: vaultOwnerToken || undefined,
        build: (context) => {
          const existingFinancial =
            (context.currentDomainData as Record<string, unknown> | null) ?? {};
          const existingDocumentsRaw = existingFinancial.documents;
          const existingDocuments =
            existingDocumentsRaw &&
            typeof existingDocumentsRaw === "object" &&
            !Array.isArray(existingDocumentsRaw)
              ? ({ ...(existingDocumentsRaw as Record<string, unknown>) } as Record<string, unknown>)
              : {};

          const nextFinancialDomain = {
            ...existingFinancial,
            schema_version: 3,
            domain_intent: {
              primary: "financial",
              source: "domain_registry_prepopulate",
              contract_version: 2,
              updated_at: nowIso,
            },
            portfolio: {
              ...clearedPortfolioData,
              domain_intent: {
                primary: "financial",
                secondary: "portfolio",
                source: "kai_dashboard_delete_import",
                captured_sections: ["account_info", "account_summary", "holdings", "documents"],
                updated_at: nowIso,
              },
            },
            documents: {
              ...existingDocuments,
              schema_version: 1,
              statements: [],
              documents_count: 0,
              last_statement_end: null,
              last_brokerage: null,
              parse_fallback_last_import: null,
              sparse_sections_last_import: [],
              last_updated: nowIso,
              domain_intent: {
                primary: "financial",
                secondary: "documents",
                source: "kai_dashboard_delete_import",
                updated_at: nowIso,
              },
            },
            updated_at: nowIso,
          };

          return {
            domainData: nextFinancialDomain as Record<string, unknown>,
            summary: {
              intent_source: "kai_dashboard_delete_import",
              has_portfolio: false,
              holdings_count: 0,
              attribute_count: 0,
              item_count: 0,
              investable_positions_count: 0,
              cash_positions_count: 0,
              allocation_coverage_pct: 0,
              parser_quality_score: 0,
              last_statement_total_value: 0,
              documents_count: 0,
              last_statement_end: null,
              last_brokerage: null,
              parse_fallback_last_import: null,
              sparse_sections_last_import: [],
              domain_contract_version: 2,
              intent_map: [...FINANCIAL_INTENT_MAP],
              last_updated: nowIso,
            },
          };
        },
      });

      if (!result.success) {
        throw new Error("Failed to delete imported data");
      }

      CacheSyncService.onPkmDomainCleared(userId, "financial");
      baselineBySourceRef.current = new Map();
      setHoldingsDraft([]);
      setDeleteImportedDialogOpen(false);
      toast.success("Imported portfolio data deleted.");
      await reload();

      if ((plaidStatus?.aggregate?.item_count || 0) > 0) {
        await changeActiveSource("plaid").catch(() => undefined);
      } else if (typeof onReupload === "function") {
        onReupload();
      }
    } catch (error) {
      console.error("[DashboardMasterView] Failed to delete imported data:", error);
      toast.error("We could not delete imported data. Please try again.");
    } finally {
      setIsDeletingImportedData(false);
    }
  }, [
    changeActiveSource,
    onReupload,
    plaidStatus?.aggregate?.item_count,
    reload,
    statementEditablePortfolio,
    userId,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handleEditHolding = useCallback(
    (holdingId: string) => {
      const row = holdingsDraft.find((holding) => holding.client_id === holdingId);
      if (!row) return;
      if (row.pending_delete) {
        toast.info("Restore this holding before editing.");
        return;
      }
      setEditingHolding({ ...row, pending_delete: false });
      setEditingHoldingId(holdingId);
      setIsModalOpen(true);
    },
    [holdingsDraft]
  );

  const handleSaveHolding = useCallback(
    (updatedHolding: PortfolioHolding) => {
      const quantity = Number(updatedHolding.quantity);
      const price = Number(updatedHolding.price);
      const marketValue = Number(updatedHolding.market_value);

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(price) ||
        !Number.isFinite(marketValue) ||
        quantity <= 0 ||
        price <= 0 ||
        marketValue <= 0
      ) {
        toast.error("Quantity, price, and market value must all be greater than 0.");
        return;
      }

      const normalizedHolding: PortfolioHolding = {
        ...updatedHolding,
        quantity,
        price,
        market_value: marketValue,
      };

      setHoldingsDraft((prev) => {
        const next = [...prev];
        const targetIndex = editingHoldingId
          ? next.findIndex((holding) => holding.client_id === editingHoldingId)
          : -1;

        if (targetIndex >= 0) {
          const existing = next[targetIndex];
          if (!existing) return next;
          next[targetIndex] = {
            ...existing,
            ...normalizedHolding,
            pending_delete: false,
            client_id: existing.client_id,
            source_key: existing.source_key,
          };
        } else {
          next.push({
            ...normalizedHolding,
            pending_delete: false,
            client_id: createLocalHoldingId(),
          });
        }
        return next;
      });
      closeHoldingModal();
    },
    [closeHoldingModal, editingHoldingId]
  );

  const handleToggleDeleteHolding = useCallback((holdingId: string) => {
    setHoldingsDraft((prev) =>
      prev.map((holding) =>
        holding.client_id === holdingId
          ? { ...holding, pending_delete: !holding.pending_delete }
          : holding
      )
    );
  }, []);

  const holdingsTableDenominator = useMemo(() => {
    const activeTotal = sourceHoldingRows
      .filter((holding) => !holding.pending_delete)
      .reduce((sum, holding) => sum + Number(holding.market_value || 0), 0);
    if (activeTotal > 0) return activeTotal;
    return sourceHoldingRows.reduce((sum, holding) => sum + Number(holding.market_value || 0), 0);
  }, [sourceHoldingRows]);

  const holdingsTableColumns = useMemo<ColumnDef<ManagedHolding>[]>(
    () => {
      const columns: ColumnDef<ManagedHolding>[] = [
        {
          accessorKey: "symbol",
          header: "Holding",
          cell: ({ row }) => {
            const holding = row.original;
            const isCash = holding.is_cash_equivalent === true;
            const isDeleted = Boolean(holding.pending_delete);
            return (
              <div className={cn("flex min-w-[220px] items-center gap-3", isDeleted && "opacity-60")}>
                <SymbolAvatar
                  symbol={holding.symbol}
                  name={holding.name}
                  isCash={isCash}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("font-semibold text-foreground", isDeleted && "line-through")}>
                      {holding.symbol || "—"}
                    </span>
                    {isCash ? (
                      <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                        Cash
                      </span>
                    ) : null}
                    {isDeleted ? (
                      <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                        Pending delete
                      </span>
                    ) : null}
                  </div>
                  <div className={cn("truncate text-xs text-muted-foreground", isDeleted && "line-through")}>
                    {holding.name || "Unnamed security"}
                  </div>
                </div>
              </div>
            );
          },
        },
        {
          id: "shares",
          header: "Shares",
          cell: ({ row }) => {
            const holding = row.original;
            return (
              <span className={cn("text-sm text-foreground", holding.pending_delete && "line-through text-muted-foreground")}>
                {Number(holding.quantity || 0).toLocaleString()}
              </span>
            );
          },
        },
        {
          accessorKey: "price",
          header: "Price",
          cell: ({ row }) => {
            const holding = row.original;
            return (
              <span className={cn("text-sm text-foreground", holding.pending_delete && "line-through text-muted-foreground")}>
                {formatCurrency(Number(holding.price || 0))}
              </span>
            );
          },
        },
        {
          accessorKey: "market_value",
          header: "Market Value",
          cell: ({ row }) => {
            const holding = row.original;
            return (
              <span className={cn("font-semibold text-foreground", holding.pending_delete && "line-through text-muted-foreground")}>
                {formatCurrency(Number(holding.market_value || 0))}
              </span>
            );
          },
        },
        {
          id: "weight",
          header: "Weight",
          cell: ({ row }) => {
            const holding = row.original;
            const marketValue = Number(holding.market_value || 0);
            const weightPct = holdingsTableDenominator > 0 ? (marketValue / holdingsTableDenominator) * 100 : 0;
            return (
              <span className={cn("text-sm text-muted-foreground", holding.pending_delete && "line-through")}>
                {formatPercent(weightPct)}
              </span>
            );
          },
        },
        {
          id: "gain_loss",
          header: "Gain / Loss",
          cell: ({ row }) => {
            const holding = row.original;
            const explicitGain = Number.isFinite(Number(holding.unrealized_gain_loss))
              ? Number(holding.unrealized_gain_loss)
              : null;
            const derivedGain =
              Number.isFinite(Number(holding.market_value)) && Number.isFinite(Number(holding.cost_basis))
                ? Number(holding.market_value) - Number(holding.cost_basis)
                : null;
            const gain = explicitGain ?? derivedGain;
            if (gain === null) {
              return <span className="text-sm text-muted-foreground">—</span>;
            }
            return (
              <span
                className={cn(
                  "font-medium",
                  holding.pending_delete
                    ? "line-through text-muted-foreground"
                    : gain >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                )}
              >
                {formatSignedCurrency(gain)}
              </span>
            );
          },
        },
      ];

      if (canEditStatement) {
        columns.unshift({
          id: "row_actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => (
            <div className="flex items-center justify-center" onClick={(event) => event.stopPropagation()}>
              <HoldingRowActions
                symbol={row.original.symbol}
                isDeleted={Boolean(row.original.pending_delete)}
                disableEdit={Boolean(row.original.pending_delete)}
                layout="row"
                className="w-auto"
                onEdit={() => handleEditHolding(row.original.client_id)}
                onToggleDelete={() => handleToggleDeleteHolding(row.original.client_id)}
              />
            </div>
          ),
        });
      }

      return columns;
    },
    [canEditStatement, handleEditHolding, handleToggleDeleteHolding, holdingsTableDenominator]
  );

  const handleSharePortfolioPdf = useCallback(async () => {
    if (isSharingPortfolioPdf || !hasShareablePortfolioData) return;

    setIsSharingPortfolioPdf(true);
    try {
      const result = await exportPortfolioPdf(portfolioSharePayload);
      if (result === "download") {
        toast.success("Portfolio PDF exported.");
      } else {
        toast.success("Portfolio PDF shared.");
      }
    } catch (error) {
      const message = String((error as Error)?.message || "").toLowerCase();
      if (
        message.includes("cancel") ||
        message.includes("cancelled") ||
        message.includes("canceled")
      ) {
        return;
      }
      console.error("[DashboardMasterView] Failed to share portfolio PDF:", error);
      toast.error("Could not share portfolio PDF.");
    } finally {
      setIsSharingPortfolioPdf(false);
    }
  }, [hasShareablePortfolioData, isSharingPortfolioPdf, portfolioSharePayload]);

  const plaidItems = useMemo<PlaidItemSummary[]>(
    () => plaidStatus?.items || [],
    [plaidStatus]
  );
  const sourceDisplayLabel = activeSource === "statement" ? "Statement" : "Plaid";
  const dashboardVoiceSurfaceMetadata = useMemo(() => {
    const activeTabLabel =
      dashboardMainTab === "overview"
        ? "Overview"
        : dashboardMainTab === "holdings"
          ? "Holdings"
          : "Deep Dive";
    const sections = [
      {
        id: "source_overview",
        title: "Source overview",
        purpose: "Summarizes the active portfolio source, value, and top actions.",
      },
      {
        id: "overview",
        title: "Overview",
        purpose: "Shows brokerage summary, transfers, allocation, transactions, and investor snapshot.",
      },
      {
        id: "holdings",
        title: "Holdings",
        purpose: "Shows current holdings, editability, and source-specific holding actions.",
      },
      {
        id: "deep_dive",
        title: "Deep Dive",
        purpose: "Shows charts, picks, and deeper portfolio recommendations.",
      },
    ];
    const actions = [
      {
        id: "kai.portfolio.optimize",
        label: "Optimize portfolio",
        purpose: "Opens the optimization workspace with the current source context.",
        voiceAliases: ["optimize portfolio", "open optimize"],
      },
      {
        id: "nav.investments",
        label: "View investments",
        purpose: "Opens the investments workspace for the current portfolio source.",
        voiceAliases: ["view investments", "open investments"],
      },
      {
        id: "kai.portfolio.connect_plaid",
        label: hasPlaidConnections ? "Connect another brokerage" : "Connect Plaid",
        purpose: "Starts or updates the Plaid brokerage connection flow.",
        voiceAliases: ["connect plaid", "connect brokerage"],
      },
      {
        id: "kai.portfolio.refresh_plaid",
        label: "Refresh Plaid",
        purpose: "Refreshes the current brokerage snapshot from Plaid.",
        voiceAliases: ["refresh plaid", "refresh brokerage"],
      },
      {
        id: "kai.portfolio.share_pdf",
        label: "Share portfolio PDF",
        purpose: "Exports the current portfolio view as a shareable PDF.",
        voiceAliases: ["share portfolio pdf", "export pdf"],
      },
      ...(canEditStatement
        ? [
            {
              id: "kai.portfolio.import_statement",
              label: "Import portfolio",
              purpose: "Returns to portfolio import for the editable statement source.",
              voiceAliases: ["import portfolio", "upload statement"],
            },
            {
              id: "kai.portfolio.delete_imported_data",
              label: "Delete imported data",
              purpose: "Deletes the imported statement portfolio from Kai.",
              voiceAliases: ["delete imported data"],
            },
          ]
        : []),
    ];
    const controls = [
      {
        id: "share_portfolio_pdf",
        label: "Share portfolio PDF",
        purpose: "Exports the current portfolio as a shareable PDF.",
        actionId: "kai.portfolio.share_pdf",
        role: "button",
        voiceAliases: ["share portfolio pdf", "share pdf"],
      },
      {
        id: "optimize_portfolio",
        label: "Optimize portfolio",
        purpose: "Opens the optimization workspace with the current source context.",
        actionId: "kai.portfolio.optimize",
        role: "button",
        voiceAliases: ["optimize portfolio", "open optimize"],
      },
      {
        id: "view_investments",
        label: "View investments",
        purpose: "Opens the investments workspace from portfolio.",
        actionId: "nav.investments",
        role: "button",
        voiceAliases: ["view investments", "open investments"],
      },
      {
        id: "connect_plaid",
        label: hasPlaidConnections ? "Connect another brokerage" : "Connect Plaid",
        purpose: "Starts or updates the Plaid brokerage connection flow.",
        actionId: "kai.portfolio.connect_plaid",
        role: "button",
        voiceAliases: ["connect plaid", "connect brokerage"],
      },
      {
        id: "portfolio_tab_overview",
        label: "Overview tab",
        purpose: "Shows source status, transfers, allocation, and investor snapshot.",
        role: "tab",
      },
      {
        id: "portfolio_tab_holdings",
        label: "Holdings tab",
        purpose: "Shows holdings, editability, and source-specific holding actions.",
        role: "tab",
      },
      {
        id: "portfolio_tab_deep_dive",
        label: "Deep Dive tab",
        purpose: "Shows deeper charts, picks, and recommendation context.",
        role: "tab",
      },
      ...(canEditStatement
        ? [
            {
              id: "import_portfolio",
              label: "Import portfolio",
              purpose: "Returns to statement import for an editable portfolio source.",
              actionId: "kai.portfolio.import_statement",
              role: "button",
            },
            {
              id: "delete_imported_data",
              label: "Delete imported data",
              purpose: "Deletes the imported statement portfolio from Kai.",
              actionId: "kai.portfolio.delete_imported_data",
              role: "button",
            },
          ]
        : [
            {
              id: "refresh_plaid",
              label: "Refresh Plaid",
              purpose: "Refreshes the current Plaid brokerage snapshot.",
              actionId: "kai.portfolio.refresh_plaid",
              role: "button",
            },
          ]),
    ];

    let visibleModules = ["Source overview", activeTabLabel];
    if (!displayedPortfolio) {
      visibleModules = ["Source overview", "Portfolio setup"];
    } else if (dashboardMainTab === "overview") {
      visibleModules = [
        "Source overview",
        "Brokerage summary",
        "Funding transfers",
        "Investor snapshot",
        "Recent transactions",
      ];
    } else if (dashboardMainTab === "holdings") {
      visibleModules = ["Source overview", "Current holdings", "Holdings actions"];
    } else {
      visibleModules = ["Source overview", "Portfolio insights", "Recommendations"];
    }

    return {
      screenId: "kai_portfolio_dashboard",
      title: "Portfolio",
      purpose:
        "This screen is the holdings workspace for source switching, portfolio context, and optimization.",
      primaryEntity: sourceDisplayLabel,
      sections,
      actions,
      controls,
      concepts: [
        {
          id: "portfolio",
          label: "Portfolio",
          explanation:
            "Portfolio is the holdings workspace for source switching, imported data, and optimization context.",
          aliases: ["portfolio", "holdings", "portfolio dashboard"],
        },
      ],
      activeSection: displayedPortfolio ? activeTabLabel : "Source overview",
      activeTab: displayedPortfolio ? dashboardMainTab : null,
      visibleModules,
      focusedWidget: displayedPortfolio ? activeTabLabel : "Portfolio setup",
      availableActions: actions.map((action) => action.label),
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(isSourcesLoading ? ["portfolio_sources_load"] : []),
        ...(isPlaidRefreshing ? ["plaid_refresh"] : []),
        ...(isLinkingPlaid ? ["plaid_link"] : []),
        ...(isLinkingFunding ? ["funding_link"] : []),
        ...(isSubmittingTransfer ? ["funding_transfer"] : []),
        ...(isSavingHoldings ? ["holdings_save"] : []),
        ...(isDeletingImportedData ? ["delete_imported_data"] : []),
        ...(isSharingPortfolioPdf ? ["portfolio_share_pdf"] : []),
      ],
      screenMetadata: {
        source_label: sourceDisplayLabel,
        active_source: activeSource,
        dashboard_tab: dashboardMainTab,
        has_displayed_portfolio: Boolean(displayedPortfolio),
        holdings_count: displayedPortfolio?.holdings?.length || 0,
        investable_holdings_count: model.hero.investableHoldingsCount,
        total_value: model.hero.totalValue,
        has_plaid_connections: hasPlaidConnections,
        plaid_connected_institution_count: plaidStatus?.aggregate?.item_count || 0,
        statement_snapshot_count: statementSnapshots.length,
        can_edit_statement: canEditStatement,
        plaid_refreshing: isPlaidRefreshing,
        plaid_view: isPlaidView,
        sync_status: freshness?.syncStatus || null,
        last_synced_at: freshness?.lastSyncedAt || null,
      },
    };
  }, [
    activeVoiceControlId,
    activeSource,
    canEditStatement,
    dashboardMainTab,
    displayedPortfolio,
    freshness?.lastSyncedAt,
    freshness?.syncStatus,
    hasPlaidConnections,
    isDeletingImportedData,
    isLinkingFunding,
    isLinkingPlaid,
    isPlaidView,
    isPlaidRefreshing,
    isSavingHoldings,
    isSharingPortfolioPdf,
    isSourcesLoading,
    isSubmittingTransfer,
    lastVoiceControlId,
    model.hero.investableHoldingsCount,
    model.hero.totalValue,
    plaidStatus?.aggregate?.item_count,
    sourceDisplayLabel,
    statementSnapshots.length,
  ]);
  usePublishVoiceSurfaceMetadata(dashboardVoiceSurfaceMetadata);

  if (isSourcesLoading && !displayedPortfolio) {
    return (
      <div className="flex w-full items-center justify-center pb-6">
        <SurfaceCard className="w-full">
          <SurfaceCardContent className="flex items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading portfolio sources...
          </SurfaceCardContent>
        </SurfaceCard>
      </div>
    );
  }

  if (!displayedPortfolio) {
    return (
      <div className="w-full space-y-6 pb-6">
        <PageHeader
          eyebrow="Kai Portfolio"
          title="Portfolio"
          description="Switch between statement and Plaid sources, connect brokerages, and keep your investable context ready for debate."
          icon={Building2}
          accent="default"
        />
        <PortfolioSourceSwitcher
          activeSource={activeSource}
          availableSources={availableSources}
          freshness={freshness}
          onSourceChange={handleSourceChange}
          statementSnapshots={statementSnapshots}
          activeStatementSnapshotId={activeStatementSnapshotId}
          onStatementSnapshotChange={handleStatementSnapshotChange}
          onRefreshPlaid={hasPlaidConnections ? () => handleRefreshPlaid() : undefined}
          onCancelRefreshPlaid={isPlaidRefreshing ? () => handleCancelPlaidRefresh() : undefined}
          onManageConnections={plaidConfigured !== false ? () => void openPlaidLinkFlow() : undefined}
          isRefreshing={isPlaidRefreshing || isLinkingPlaid}
        />
        <SurfaceCard>
          <SurfaceCardContent className="space-y-3 p-6">
            <p className="text-sm font-semibold">No active portfolio source is ready yet.</p>
            <p className="text-sm text-muted-foreground">
              Import a statement for an editable source, or connect Plaid for read-only brokerage data.
            </p>
            {plaidConfigured !== false ? (
              <div className="flex flex-wrap gap-2">
                <MorphyButton
                  variant="blue-gradient"
                  effect="fill"
                  onClick={() => void openPlaidLinkFlow()}
                  disabled={isLinkingPlaid}
                >
                  {isLinkingPlaid ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Building2 className="mr-2 h-4 w-4" />}
                  Connect Plaid
                </MorphyButton>
                <MorphyButton variant="none" effect="fade" onClick={onReupload}>
                  Upload Statement
                </MorphyButton>
              </div>
            ) : null}
          </SurfaceCardContent>
        </SurfaceCard>
      </div>
    );
  }

  return (
    <div className="w-full space-y-8 pb-6">
      <PageHeader
        eyebrow="Kai Portfolio"
        title="Portfolio"
        description="Your active source, holdings context, and brokerage connections stay in sync here before you move into investments, debate, or optimization."
        icon={Building2}
        accent="default"
        actions={
          <MorphyButton
            variant="none"
            effect="fade"
            size="sm"
            onClick={() => void handleSharePortfolioPdf()}
            disabled={!hasShareablePortfolioData || isSharingPortfolioPdf}
            className="h-10 w-10 rounded-full border border-transparent bg-[var(--app-card-surface-compact)] p-0 text-foreground shadow-[var(--shadow-xs)] hover:bg-[var(--app-card-surface-default)]"
            aria-label="Share portfolio PDF"
            title={hasShareablePortfolioData ? "Share portfolio PDF" : "No shareable portfolio data yet"}
            data-voice-control-id="share_portfolio_pdf"
          >
            {isSharingPortfolioPdf ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="h-4 w-4" />
            )}
          </MorphyButton>
        }
      />
      <PortfolioSourceSwitcher
        activeSource={activeSource}
        availableSources={availableSources}
        freshness={freshness}
        onSourceChange={handleSourceChange}
        statementSnapshots={statementSnapshots}
        activeStatementSnapshotId={activeStatementSnapshotId}
        onStatementSnapshotChange={handleStatementSnapshotChange}
        onRefreshPlaid={hasPlaidConnections ? () => handleRefreshPlaid() : undefined}
        onCancelRefreshPlaid={isPlaidRefreshing ? () => handleCancelPlaidRefresh() : undefined}
        onManageConnections={plaidConfigured !== false ? () => void openPlaidLinkFlow() : undefined}
        isRefreshing={isPlaidRefreshing || isLinkingPlaid}
      />

      {sourcesError ? (
        <SurfaceCard tone="warning">
          <SurfaceCardContent className="p-4 text-sm text-muted-foreground">
            {sourcesError}
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}

      <SurfaceCard tone="feature">
        <SurfaceCardContent className="space-y-6 p-6 sm:p-7">
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              {sourceDisplayLabel} portfolio value
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <span className="inline-flex items-center rounded-full border border-transparent bg-[var(--app-card-surface-compact)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground shadow-[var(--shadow-xs)]">
                Source: {sourceDisplayLabel}
              </span>
              <span className="inline-flex items-center rounded-full border border-transparent bg-[var(--app-card-surface-compact)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground shadow-[var(--shadow-xs)]">
                Risk: {model.hero.portfolioConcentrationLabel.replace(" Concentration", "")}
              </span>
              <span className="inline-flex items-center rounded-full border border-transparent bg-[var(--app-card-surface-compact)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground shadow-[var(--shadow-xs)]">
                Holdings: {model.hero.investableHoldingsCount}
              </span>
              {model.hero.cashPositionsCount > 0 ? (
                <span className="inline-flex items-center rounded-full border border-transparent bg-[var(--app-card-surface-compact)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground shadow-[var(--shadow-xs)]">
                  Cash Positions: {model.hero.cashPositionsCount}
                </span>
              ) : null}
            </div>
            <p className="text-4xl font-black tracking-tight">{formatCurrency(model.hero.totalValue)}</p>
            <div className="flex items-center justify-center gap-2 text-sm">
              <span
                className={cn(
                  "inline-flex items-center font-semibold",
                  model.hero.netChange >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                )}
              >
                <Icon icon={model.hero.netChange >= 0 ? TrendingUp : TrendingDown} size="sm" className="mr-1" />
                {model.hero.netChange >= 0 ? "+" : ""}
                {formatCurrency(model.hero.netChange)} ({model.hero.changePct.toFixed(2)}%)
              </span>
              {model.hero.statementPeriod ? (
                <>
                  <span className="text-muted-foreground">•</span>
                  <span className="text-muted-foreground">{model.hero.statementPeriod}</span>
                </>
              ) : null}
            </div>
          </div>

          <SurfaceInset className="text-center">
            <p className="text-sm font-semibold">
              {isPlaidView
                ? freshness?.lastSyncedAt
                  ? `Last synced ${new Date(freshness.lastSyncedAt).toLocaleString()}`
                  : "Plaid brokerage snapshot"
                : model.hero.statementPeriod || "Current statement period"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isPlaidView ? (
                <>
                  {freshness?.itemCount || 0} item{(freshness?.itemCount || 0) === 1 ? "" : "s"} •{" "}
                  {freshness?.accountCount || 0} account{(freshness?.accountCount || 0) === 1 ? "" : "s"} • read-only broker data
                </>
              ) : (
                <>
                  Beginning Balance:{" "}
                  <span className="font-semibold text-foreground">{formatCurrency(model.hero.beginningValue)}</span>
                </>
              )}
            </p>
          </SurfaceInset>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <MorphyButton
              variant="blue-gradient"
              effect="fill"
              onClick={handleOptimizePortfolio}
              data-voice-control-id="optimize_portfolio"
            >
              <ArrowRight className="mr-2 h-4 w-4" />
              Optimize Portfolio
            </MorphyButton>
            <MorphyButton
              variant="none"
              effect="fade"
              onClick={() => router.push(ROUTES.KAI_INVESTMENTS)}
              data-voice-control-id="view_investments"
            >
              <Building2 className="mr-2 h-4 w-4" />
              View Investments
            </MorphyButton>
            {plaidConfigured !== false ? (
              <MorphyButton
                variant="none"
                effect="fade"
                onClick={() => void openPlaidLinkFlow()}
                disabled={isLinkingPlaid}
                data-voice-control-id="connect_plaid"
              >
                {isLinkingPlaid ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Building2 className="mr-2 h-4 w-4" />
                )}
                {hasPlaidConnections ? "Connect Another Brokerage" : "Connect Plaid"}
              </MorphyButton>
            ) : null}
            <MorphyButton
              variant="none"
              effect="fade"
              onClick={() => router.push(ROUTES.KAI_FUNDING_TRADE)}
            >
              <BadgeDollarSign className="mr-2 h-4 w-4" />
              Fund + Trade
            </MorphyButton>
          </div>
        </SurfaceCardContent>
      </SurfaceCard>

      <Tabs
        value={dashboardMainTab}
        onValueChange={(value) => {
          if (!isDashboardMainTab(value)) return;
          setDashboardMainTab(value);
        }}
        className="space-y-4"
      >
        <SegmentedTabs
          value={dashboardMainTab}
          onValueChange={(value) => {
            if (!isDashboardMainTab(value)) return;
            setDashboardMainTab(value);
          }}
          options={[
            { value: "overview", label: "Overview" },
            { value: "holdings", label: "Holdings" },
            { value: "deep-dive", label: "Deep Dive" },
          ]}
          className="w-full"
        />

        <TabsContent value="overview" className="mt-0 space-y-4">
          <PlaidBrokerageSummarySection
            items={plaidItems}
            onRefreshItem={(itemId) => handleRefreshPlaid(itemId)}
            onCancelRefresh={(params) => handleCancelPlaidRefresh(params)}
            onManageConnection={(itemId) => void openPlaidLinkFlow(itemId)}
            onViewInvestments={() => router.push(ROUTES.KAI_INVESTMENTS)}
          />

          <PlaidFundingTransfersSection
            className="hidden"
            fundingStatus={plaidFundingStatus}
            onManageBrokerage={() => void handleConnectFundingBrokerage()}
            onConnectFunding={(itemId) => void openPlaidFundingLinkFlow(itemId)}
            onSetDefaultFundingAccount={(payload) => void handleSetDefaultFundingAccount(payload)}
            onRunReconciliation={() => void handleRunFundingReconciliation()}
            onCreateTransfer={(payload) => void handleCreateFundingTransfer(payload)}
            onRefreshTransfer={(transferId) => void handleRefreshTransfer(transferId)}
            onCancelTransfer={(transferId) => void handleCancelTransfer(transferId)}
            onSearchFundingRecords={(payload) => handleSearchFundingRecords(payload)}
            onCreateFundingEscalation={(payload) => handleCreateFundingEscalation(payload)}
            isConnectingFunding={isLinkingFunding}
            isSubmittingTransfer={isSubmittingTransfer}
            isReconciling={isReconcilingFunding}
          />

          <section className="space-y-4">
            {hasEquitySectorAllocation ? (
              <SectorAllocationChart
                className="min-w-0"
                holdings={equitySectorChartHoldings}
                title="Equity Sector Allocation"
                subtitle={`${(equitySectorCoveragePct * 100).toFixed(0)}% of equity holdings have mapped sector labels. Denominator: ${formatCurrency(model.hero.totalValue)} total portfolio value.`}
              />
            ) : (
              <FallbackSurfaceCard
                title="Equity Sector Allocation"
                detail="No equity holdings are currently available for sector-level allocation."
              />
            )}

            {hasNonEquityAllocation ? (
              <SectorAllocationChart
                className="min-w-0"
                holdings={nonEquityAllocationChartHoldings}
                title="Non-Equity Allocation"
                subtitle={`${(nonEquityCoveragePct * 100).toFixed(0)}% of non-equity holdings are mapped to canonical allocation buckets. Denominator: ${formatCurrency(model.hero.totalValue)} total portfolio value.`}
              />
            ) : (
              <FallbackSurfaceCard
                title="Non-Equity Allocation"
                detail="No non-equity holdings are present in the current portfolio."
              />
            )}
          </section>

          {activeSource === "statement" && statementSnapshotRows.length > 0 ? (
            <StatementCashflowChart data={statementChartData} />
          ) : null}

          <TransactionActivity
            transactions={recentTransactions}
            maxItems={6}
            className="min-w-0"
          />

          <SurfaceCard>
            <SurfaceCardHeader className="px-6 pb-2 pt-6 sm:px-7">
              <SurfaceCardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                Investor Snapshot
              </SurfaceCardTitle>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-4 px-6 pb-6 pt-0 sm:px-7 sm:pb-7">
              <div className="grid gap-3 sm:grid-cols-2">
                <SurfaceInset className="p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Debate Readiness
                  </p>
                  <p className="mt-1 text-2xl font-black">{investorSnapshot.readinessScore}</p>
                  <p className="text-xs text-muted-foreground">Context quality score (0-100)</p>
                </SurfaceInset>
                <SurfaceInset className="p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Optimization Pressure
                  </p>
                  <p className="mt-1 text-2xl font-black">{formatPercent(investorSnapshot.optimizationPressurePct)}</p>
                  <p className="text-xs text-muted-foreground">
                    Portfolio value in losing positions
                  </p>
                </SurfaceInset>
                <SurfaceInset className="p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Top 3 Concentration
                  </p>
                  <p className="mt-1 text-2xl font-black">{formatPercent(investorSnapshot.top3ConcentrationPct)}</p>
                  <p className="text-xs text-muted-foreground">
                    Largest three holdings share
                  </p>
                </SurfaceInset>
                <SurfaceInset className="p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Estimated Annual Income
                  </p>
                  <p className="mt-1 text-2xl font-black">{formatCurrency(investorSnapshot.estimatedAnnualIncome)}</p>
                  <p className="text-xs text-muted-foreground">
                    Yield {formatPercent(investorSnapshot.annualYieldPct)}
                  </p>
                </SurfaceInset>
              </div>

              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <SurfaceInset className="rounded-lg px-3 py-2">
                  {investorSnapshot.losersCount} losers / {investorSnapshot.winnersCount} winners
                </SurfaceInset>
                <SurfaceInset className="rounded-lg px-3 py-2">
                  {investorSnapshot.uniqueSectors} sector buckets represented
                </SurfaceInset>
                <SurfaceInset className="rounded-lg px-3 py-2">
                  Cash allocation {formatPercent(investorSnapshot.cashPct)}
                </SurfaceInset>
                <SurfaceInset className="rounded-lg px-3 py-2">
                  Fixed income {formatPercent(investorSnapshot.fixedIncomePct)} / Real assets{" "}
                  {formatPercent(investorSnapshot.realAssetsPct)}
                </SurfaceInset>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>
        </TabsContent>

        <TabsContent value="holdings" className="mt-0 space-y-4">
          <SurfaceCard className="min-w-0">
            <SurfaceCardHeader className="px-6 pb-2 pt-6 sm:px-7">
              <div className="flex items-center justify-between gap-2">
                <SurfaceCardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                  {isPlaidView ? "Brokerage Holdings" : "Current Holdings"}
                </SurfaceCardTitle>
                {canEditStatement ? (
                  <MorphyButton
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={openAddHoldingModal}
                    data-voice-control-id="add_holding"
                  >
                    <Icon icon={Plus} size="sm" className="mr-1" />
                    Add Holding
                  </MorphyButton>
                ) : (
                  <span className="text-xs text-muted-foreground">Read-only source</span>
                )}
              </div>
            </SurfaceCardHeader>

            <SurfaceCardContent className="space-y-4 px-6 pb-6 pt-0 sm:px-7 sm:pb-7">
              <SurfaceInset className="px-3 py-2.5 text-xs text-muted-foreground">
                {canEditStatement ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">Change Summary</span>
                    <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">Added: {holdingsChangeSummary.added}</span>
                    <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">Edited: {holdingsChangeSummary.edited}</span>
                    <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">Deleted: {holdingsChangeSummary.deleted}</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">Plaid Snapshot</span>
                    <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">
                      Sync: {freshness?.syncStatus || "idle"}
                    </span>
                    <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">
                      Items: {freshness?.itemCount || 0}
                    </span>
                    <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">
                      Accounts: {freshness?.accountCount || 0}
                    </span>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">Bifurcation</span>
                  <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">
                    Equities: {holdingsBifurcation.analyzeEligible}
                  </span>
                  <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">
                    Other Assets: {holdingsBifurcation.nonAnalyzable}
                  </span>
                  <span className="rounded-full border border-transparent bg-[var(--app-card-surface-default)] px-2 py-0.5 shadow-[var(--shadow-xs)]">
                    Cash: {holdingsBifurcation.cashSweep}
                  </span>
                </div>
                {!canEditStatement ? (
                  <div className="mt-2 rounded-lg border border-dashed border-border/60 bg-muted/40 px-3 py-2 text-xs">
                    Plaid holdings are broker-sourced and cannot be edited in Kai.
                  </div>
                ) : null}
              </SurfaceInset>

              <DataTable
                columns={holdingsTableColumns}
                data={sourceHoldingRows}
                searchKey="symbol"
                globalSearchKeys={["symbol", "name"]}
                searchPlaceholder="Search holdings by ticker or company"
                initialPageSize={8}
                pageSizeOptions={[8, 16, 24]}
                rowClassName={(holding) =>
                  cn(
                    "transition-colors",
                    holding.pending_delete && "bg-rose-500/5"
                  )
                }
              />

              {canEditStatement && hasHoldingsChanges ? (
                <div className="pt-2">
                  <MorphyButton
                    variant="blue-gradient"
                    effect="fade"
                    fullWidth
                    onClick={() => void persistHoldingsChanges()}
                    disabled={isSavingHoldings}
                    className="bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
                    data-voice-control-id="save_holdings_changes"
                  >
                    <Icon icon={Save} size="sm" className="mr-2" />
                    {isSavingHoldings ? "Saving Holdings..." : "Save Holdings Changes"}
                  </MorphyButton>
                </div>
              ) : null}
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceCard>
            <SurfaceCardContent className="flex flex-col gap-3 p-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <p>
                {canEditStatement
                  ? "Imported statement data is synced across dashboard and holdings views."
                  : "Plaid brokerage data is broker-sourced, refreshable, and read-only inside Kai."}
              </p>
              <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2">
                <MorphyButton
                  variant="none"
                  effect="fade"
                  size="sm"
                  fullWidth
                  disabled={isDeletingImportedData}
                  onClick={canEditStatement ? onReupload : () => void openPlaidLinkFlow()}
                  data-voice-control-id="import_portfolio"
                >
                  {canEditStatement ? "Import Portfolio" : "Connect Another Brokerage"}
                </MorphyButton>
                {canEditStatement ? (
                  <MorphyButton
                    variant="none"
                    effect="fade"
                    size="sm"
                    fullWidth
                    className="text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                    disabled={isDeletingImportedData}
                    onClick={() => setDeleteImportedDialogOpen(true)}
                    data-voice-control-id="delete_imported_data"
                  >
                    {isDeletingImportedData ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1 h-4 w-4" />
                    )}
                    Delete Imported Data
                  </MorphyButton>
                ) : (
                  <MorphyButton
                    variant="none"
                    effect="fade"
                    size="sm"
                    fullWidth
                    onClick={() => handleRefreshPlaid()}
                    disabled={isPlaidRefreshing}
                    data-voice-control-id="refresh_plaid"
                  >
                    <RefreshCw className={`mr-1 h-4 w-4 ${isPlaidRefreshing ? "animate-spin" : ""}`} />
                    Refresh Plaid
                  </MorphyButton>
                )}
              </div>
            </SurfaceCardContent>
          </SurfaceCard>
        </TabsContent>

        <TabsContent value="deep-dive" className="mt-0 space-y-4">
          <section className="space-y-3">
            <h2 className="app-section-heading px-1 uppercase tracking-[0.12em] text-muted-foreground">
              Portfolio Insights
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {model.quality.allocationReady ? (
                <ChartSurfaceCard
                  title="Allocation Mix"
                  className="min-w-0"
                  contentClassName="space-y-0"
                >
                  <SurfaceInset>
                    <AssetAllocationDonut data={allocationData} height={240} />
                  </SurfaceInset>
                </ChartSurfaceCard>
              ) : (
                <FallbackSurfaceCard
                  title="Allocation Mix"
                  detail="Insufficient statement allocation fields to build a reliable mix chart."
                />
              )}

              {model.quality.historyReady ? (
                <PortfolioHistoryChart
                  data={model.history}
                  beginningValue={model.hero.beginningValue}
                  endingValue={model.hero.endingValue}
                  statementPeriod={model.hero.statementPeriod}
                  className="h-full min-w-0"
                />
              ) : (
                <FallbackSurfaceCard
                  title="Portfolio History"
                  detail="Insufficient statement period values to plot a defensible history trend."
                />
              )}

              {model.quality.gainLossReady ? (
                <GainLossDistributionChart
                  className="min-w-0"
                  data={model.gainLossDistribution}
                />
              ) : (
                <FallbackSurfaceCard
                  title="Gain/Loss Distribution"
                  detail="Statement lacks enough gain/loss percentages to build a reliable distribution."
                />
              )}

              {model.quality.concentrationReady ? (
                <HoldingsConcentrationChart
                  className="min-w-0"
                  data={model.concentration}
                />
              ) : (
                <FallbackSurfaceCard
                  title="Holdings Concentration"
                  detail="Need at least three measurable holdings to compute concentration safely."
                />
              )}
            </div>
          </section>

          <SurfaceCard className="min-w-0">
            <SurfaceCardContent className="p-4 sm:p-5">
              <ProfileBasedPicksList
                userId={userId}
                vaultOwnerToken={vaultOwnerToken}
                symbols={holdingSymbols}
                onAdd={handleAnalyzeFromDashboard}
              />
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceCard className="min-w-0">
            <SurfaceCardHeader>
              <SurfaceCardTitle>Recommendations</SurfaceCardTitle>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {KAI_EXPERIENCE_CONTRACT.decisionConviction.dashboardRecommendationsDescription}
              </p>
              {model.recommendations.map((item) => (
                <SurfaceInset key={item.title} className="p-3">
                  <p className="text-sm font-semibold">{item.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                </SurfaceInset>
              ))}
            </SurfaceCardContent>
          </SurfaceCard>
        </TabsContent>
      </Tabs>

      <EditHoldingModal
        isOpen={isModalOpen}
        onClose={closeHoldingModal}
        holding={editingHolding}
        onSave={handleSaveHolding}
      />

      <AlertDialog
        open={deleteImportedDialogOpen}
        onOpenChange={(open) => {
          if (isDeletingImportedData) return;
          setDeleteImportedDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Imported Portfolio Data?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes imported holdings and statement snapshots from your Vault. Profile
              and consent data are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingImportedData}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingImportedData}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteImportedData();
              }}
            >
              {isDeletingImportedData ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
