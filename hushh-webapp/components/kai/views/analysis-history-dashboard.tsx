"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Search,
  BarChart3,
  MessageSquareText,
  Trash2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";
import { Badge } from "@/components/ui/badge";
// Search is provided globally via Kai layout (bottom bar)
import {
  KaiHistoryService,
  type AnalysisHistoryEntry,
  type AnalysisHistoryMap,
} from "@/lib/services/kai-history-service";
import { DataTable } from "@/components/app-ui/data-table";
import { getColumns, type HistoryEntryWithVersion } from "./columns";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Progress } from "@/components/ui/progress";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { format } from "date-fns";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { DebateReadinessChart } from "@/components/kai/charts/debate-readiness-chart";
import { DebateRunManagerService } from "@/lib/services/debate-run-manager";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";
import {
  getTickerUniverseSnapshot,
  preloadTickerUniverse,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";

// ============================================================================
// Props
// ============================================================================

export interface AnalysisHistoryDashboardProps {
  userId: string;
  vaultKey: string;
  vaultOwnerToken?: string;
  onSelectTicker: (ticker: string) => void;
  onViewHistory: (entry: AnalysisHistoryEntry) => void;
  showDebateInputs?: boolean;
}

interface DebateCoverageRow {
  key: string;
  label: string;
  value: number;
  detail: string;
}

interface DebateInputsSnapshot {
  hasPortfolio: boolean;
  eligibleSymbols: string[];
  coverageRows: DebateCoverageRow[];
  readinessScore: number;
  exclusionSummary: Array<{ reason: string; count: number }>;
}

const GENERIC_SECTOR_LABELS = new Set([
  "unknown",
  "unclassified",
  "n/a",
  "na",
  "none",
  "other",
  "equity",
  "equities",
  "stock",
  "stocks",
]);

// ============================================================================
// Helpers
// ============================================================================

/** Map decision string to display color classes */
function decisionStyles(decision: string, ownsPosition?: boolean | null): {
  bg: string;
  text: string;
  border: string;
  icon: React.ReactNode;
  label: string;
} {
  const presentation = toInvestorDecisionLabel(decision, ownsPosition);
  if (presentation.tone === "positive") {
    return {
      bg: "bg-emerald-500/10",
      text: "text-emerald-600 dark:text-emerald-400",
      border: "border-emerald-500/30",
      icon: <Icon icon={TrendingUp} size={12} />,
      label: presentation.label,
    };
  }
  if (presentation.tone === "negative") {
    return {
      bg: "bg-red-500/10",
      text: "text-red-600 dark:text-red-400",
      border: "border-red-500/30",
      icon: <Icon icon={TrendingDown} size={12} />,
      label: presentation.label,
    };
  }
  return {
    bg:
      presentation.label === "WATCH"
        ? "bg-blue-500/10"
        : "bg-amber-500/10",
    text:
      presentation.label === "WATCH"
        ? "text-blue-600 dark:text-blue-400"
        : "text-amber-600 dark:text-amber-400",
    border:
      presentation.label === "WATCH"
        ? "border-blue-500/30"
        : "border-amber-500/30",
    icon: <Icon icon={Minus} size={12} />,
    label: presentation.label,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function isSpecificSectorLabel(value: string | null | undefined): boolean {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return !GENERIC_SECTOR_LABELS.has(text);
}

function buildTickerSectorLookup(rows: TickerUniverseRow[]): Map<string, { sector?: string; industry?: string }> {
  const lookup = new Map<string, { sector?: string; industry?: string }>();
  for (const row of rows) {
    const ticker = String(row.ticker || "").trim().toUpperCase();
    if (!ticker) continue;
    const sector = String(row.sector || row.sector_primary || "").trim() || undefined;
    const industry = String(row.industry || row.industry_primary || "").trim() || undefined;
    if (!sector && !industry) continue;
    lookup.set(ticker, { sector, industry });
  }
  return lookup;
}

function buildTickerLookupCandidates(symbol: string): string[] {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!normalized) return [];
  const candidates = new Set<string>([normalized]);

  if (normalized.includes("-")) {
    candidates.add(normalized.replace(/-/g, "."));
  }

  // Common class-share fallback (e.g. BRKB -> BRK.B) for vendor mismatch.
  if (/^[A-Z]{3,5}[A-Z]$/.test(normalized)) {
    candidates.add(`${normalized.slice(0, -1)}.${normalized.slice(-1)}`);
  }

  return Array.from(candidates);
}

function resolveSectorCoveragePct(
  mapped: ReturnType<typeof mapPortfolioToDashboardViewModel>,
  tickerSectorLookup: Map<string, { sector?: string; industry?: string }>
): number {
  const investablePositions = mapped.canonicalModel.positions.filter(
    (position) => !position.isCashEquivalent && position.debateEligible
  );
  if (investablePositions.length === 0) {
    return mapped.quality.sectorCoveragePct;
  }

  const covered = investablePositions.filter((position) => {
    const symbol = String(position.tickerSymbol || position.displaySymbol || "").trim().toUpperCase();
    const enriched = buildTickerLookupCandidates(symbol)
      .map((candidate) => tickerSectorLookup.get(candidate))
      .find((row) => row && (isSpecificSectorLabel(row.sector) || isSpecificSectorLabel(row.industry)));
    return (
      isSpecificSectorLabel(position.sector) ||
      isSpecificSectorLabel(enriched?.sector) ||
      isSpecificSectorLabel(position.assetType)
    );
  }).length;

  return covered / investablePositions.length;
}

function buildDebateInputsSnapshot(
  portfolio: PortfolioData,
  tickerSectorLookup: Map<string, { sector?: string; industry?: string }>
): DebateInputsSnapshot {
  const mapped = mapPortfolioToDashboardViewModel(portfolio);
  const sectorCoveragePct = resolveSectorCoveragePct(mapped, tickerSectorLookup);
  const coverageRows: DebateCoverageRow[] = [
    {
      key: "ticker",
      label: "Ticker",
      value: clampPercent(mapped.canonicalModel.quality.tickerCoveragePct * 100),
      detail: "Holdings mapped to tradable symbols",
    },
    {
      key: "sector",
      label: "Sector",
      value: clampPercent(sectorCoveragePct * 100),
      detail: "Investable positions with mapped sector labels",
    },
    {
      key: "gain-loss",
      label: "P/L",
      value: clampPercent(mapped.quality.gainLossCoveragePct * 100),
      detail: "Positions with gain/loss percentages",
    },
    {
      key: "investable",
      label: "Investable",
      value:
        mapped.canonicalModel.counts.totalPositions > 0
          ? clampPercent(
              (mapped.canonicalModel.counts.investablePositions
                / mapped.canonicalModel.counts.totalPositions)
                * 100
            )
          : 0,
      detail: "Positions eligible for debate runs",
    },
  ];

  const readinessScore =
    coverageRows.length > 0
      ? coverageRows.reduce((sum, row) => sum + row.value, 0) / coverageRows.length
      : 0;

  const reasonMap = new Map<string, number>();
  for (const row of mapped.canonicalModel.debateContext.excludedPositions) {
    const reason = String(row.reason || "unknown");
    reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
  }
  const exclusionSummary = Array.from(reasonMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    hasPortfolio: mapped.canonicalModel.counts.totalPositions > 0,
    eligibleSymbols: mapped.canonicalModel.debateContext.eligibleSymbols,
    coverageRows,
    readinessScore,
    exclusionSummary,
  };
}

/**
 * Dedupe history table to one row per ticker.
 *
 * - We still compute a `version` for each entry (oldest=1 ... newest=N)
 * - The table shows ONLY the latest entry per ticker
 * - Older versions are accessible via the row action menu (handled in columns)
 */
function processHistory(map: AnalysisHistoryMap): HistoryEntryWithVersion[] {
  const latestPerTicker: HistoryEntryWithVersion[] = [];
  const epochOf = (value: string): number => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  };

  Object.entries(map).forEach(([tickerKey, entries]) => {
    if (!entries?.length) return;
    const canonicalTicker = String(tickerKey || "").trim().toUpperCase();
    if (!canonicalTicker || canonicalTicker === "UNDEFINED" || canonicalTicker === "NULL") {
      return;
    }

    // Sort entries for this ticker by date ASC to assign version numbers
    const sortedByDateAsc = [...entries].sort(
      (a, b) => epochOf(a.timestamp) - epochOf(b.timestamp)
    );

    const withVersions: HistoryEntryWithVersion[] = sortedByDateAsc.map((entry, index) => ({
      ...entry,
      ticker:
        typeof entry.ticker === "string" && entry.ticker.trim().length > 0
          ? entry.ticker
          : canonicalTicker,
      version: index + 1,
    }));

    // Latest is the newest timestamp
    const latest = withVersions[withVersions.length - 1];
    if (latest) latestPerTicker.push(latest);
  });

  // Sort tickers by latest analysis date DESC
  return latestPerTicker.sort(
    (a, b) => epochOf(b.timestamp) - epochOf(a.timestamp)
  );
}

function cloneHistoryMap(historyMap: AnalysisHistoryMap): AnalysisHistoryMap {
  return Object.fromEntries(
    Object.entries(historyMap).map(([ticker, entries]) => [ticker, [...entries]])
  );
}

function toEpochMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const epoch = Date.parse(trimmed);
  return Number.isFinite(epoch) ? epoch : null;
}

function timestampsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftTrimmed = typeof left === "string" ? left.trim() : "";
  const rightTrimmed = typeof right === "string" ? right.trim() : "";
  if (!leftTrimmed || !rightTrimmed) return false;
  if (leftTrimmed === rightTrimmed) return true;
  const leftEpoch = toEpochMs(leftTrimmed);
  const rightEpoch = toEpochMs(rightTrimmed);
  if (leftEpoch === null || rightEpoch === null) return false;
  return Math.abs(leftEpoch - rightEpoch) <= 1000;
}

function normalizeTickerKey(historyMap: AnalysisHistoryMap, ticker: string): string | null {
  const wanted = String(ticker || "").trim().toUpperCase();
  const canonicalWanted = wanted.replace(/[^A-Z0-9]/g, "");
  if (!wanted && !canonicalWanted) return null;
  if (Object.prototype.hasOwnProperty.call(historyMap, wanted)) return wanted;
  const matched = Object.keys(historyMap).find((key) => {
    const keyUpper = key.toUpperCase();
    if (keyUpper === wanted) return true;
    return keyUpper.replace(/[^A-Z0-9]/g, "") === canonicalWanted;
  });
  return matched ?? null;
}

function extractEntryStreamId(entry: AnalysisHistoryEntry): string | null {
  const rawCard = entry.raw_card;
  if (!rawCard || typeof rawCard !== "object") return null;
  const diagnostics = (rawCard as Record<string, unknown>).stream_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const streamId = (diagnostics as Record<string, unknown>).stream_id;
  if (typeof streamId !== "string") return null;
  const trimmed = streamId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractEntryRunId(entry: AnalysisHistoryEntry): string | null {
  const rawCard = entry.raw_card;
  if (!rawCard || typeof rawCard !== "object") return extractEntryStreamId(entry);
  const runId = (rawCard as Record<string, unknown>).debate_run_id;
  if (typeof runId === "string" && runId.trim().length > 0) {
    return runId.trim();
  }
  return extractEntryStreamId(entry);
}

function upsertEntryInHistoryMap(
  historyMap: AnalysisHistoryMap,
  entry: AnalysisHistoryEntry
): AnalysisHistoryMap {
  const nextMap = cloneHistoryMap(historyMap);
  const canonicalTicker = String(entry.ticker || "").trim().toUpperCase();
  if (!canonicalTicker || canonicalTicker === "UNDEFINED" || canonicalTicker === "NULL") {
    return historyMap;
  }
  const tickerKey = normalizeTickerKey(nextMap, canonicalTicker) || canonicalTicker;
  const current = nextMap[tickerKey] || [];
  const incomingRunId = extractEntryRunId(entry);

  const filtered = current.filter((candidate) => {
    if (incomingRunId && extractEntryRunId(candidate) === incomingRunId) {
      return false;
    }
    return !timestampsMatch(candidate.timestamp, entry.timestamp);
  });

  const nextEntries = [entry, ...filtered]
    .sort((a, b) => {
      const aMs = Date.parse(a.timestamp);
      const bMs = Date.parse(b.timestamp);
      const aSafe = Number.isFinite(aMs) ? aMs : 0;
      const bSafe = Number.isFinite(bMs) ? bMs : 0;
      return bSafe - aSafe;
    })
    .slice(0, 3);

  nextMap[tickerKey] = nextEntries;
  return nextMap;
}

function removeEntryFromHistoryMap(
  historyMap: AnalysisHistoryMap,
  entry: AnalysisHistoryEntry
): { nextMap: AnalysisHistoryMap; changed: boolean } {
  const nextMap = cloneHistoryMap(historyMap);
  const tickerKey = normalizeTickerKey(nextMap, entry.ticker);
  if (!tickerKey) return { nextMap: historyMap, changed: false };

  const wantedTimestamp = String(entry.timestamp || "").trim();
  const wantedStreamId = extractEntryStreamId(entry);
  const current = nextMap[tickerKey] || [];
  if (current.length === 0) return { nextMap: historyMap, changed: false };

  const originalLen = current.length;
  let filtered = current.filter((candidate) => {
    const byTimestamp = wantedTimestamp.length > 0 && timestampsMatch(candidate.timestamp, wantedTimestamp);
    const byStreamId = wantedStreamId !== null && extractEntryStreamId(candidate) === wantedStreamId;
    return !(byTimestamp || byStreamId);
  });

  if (filtered.length === originalLen) {
    filtered = current.slice(1);
  }

  if (filtered.length === 0) {
    delete nextMap[tickerKey];
  } else {
    nextMap[tickerKey] = filtered;
  }

  return {
    nextMap,
    changed: filtered.length !== originalLen || !nextMap[tickerKey],
  };
}

function removeTickerFromHistoryMap(
  historyMap: AnalysisHistoryMap,
  ticker: string
): { nextMap: AnalysisHistoryMap; changed: boolean; tickerKey: string | null } {
  const nextMap = cloneHistoryMap(historyMap);
  const tickerKey = normalizeTickerKey(nextMap, ticker);
  if (!tickerKey) return { nextMap: historyMap, changed: false, tickerKey: null };
  delete nextMap[tickerKey];
  return { nextMap, changed: true, tickerKey };
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 space-y-6">
      <div className="p-4 rounded-full bg-primary/5 border border-primary/10">
        <Icon icon={BarChart3} size={32} className="text-primary/60" />
      </div>
      <div className="text-center space-y-2 max-w-sm">
        <h3 className="text-lg font-semibold">No analyses yet</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Search for a stock ticker below and let Agent Kai&apos;s multi-agent
          debate engine give you a data-driven recommendation.
        </p>
      </div>
    </div>
  );
}

interface DebateInputsCardProps {
  loading: boolean;
  snapshot: DebateInputsSnapshot | null;
  onSelectTicker: (ticker: string) => void;
  historyTickers: string[];
}

type PendingDeleteAction =
  | { kind: "entry"; entry: AnalysisHistoryEntry }
  | { kind: "ticker"; ticker: string }
  | null;

function DebateInputsCard({
  loading,
  snapshot,
  onSelectTicker,
  historyTickers,
}: DebateInputsCardProps) {
  const hasPortfolio = Boolean(snapshot?.hasPortfolio);
  const eligibleSymbols = snapshot?.eligibleSymbols || [];
  const coverageRows = snapshot?.coverageRows || [];
  const exclusionSummary = snapshot?.exclusionSummary || [];
  const quickStartTickers = eligibleSymbols.length > 0 ? eligibleSymbols : historyTickers;

  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <div className="flex items-center justify-between gap-2">
          <SurfaceCardTitle className="flex items-center gap-2 text-sm">
            <Icon icon={MessageSquareText} size="sm" className="text-primary" />
            Debate Inputs
          </SurfaceCardTitle>
          <Badge variant="secondary" className="text-[11px] font-semibold">
            {eligibleSymbols.length} eligible
          </Badge>
        </div>
        <SurfaceCardDescription>
          Start a debate directly from history using your current vault portfolio context.
        </SurfaceCardDescription>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-4">
        {loading ? (
          <SurfaceInset className="border-dashed p-3 text-sm text-muted-foreground">
            Loading debate context from vault...
          </SurfaceInset>
        ) : !hasPortfolio ? (
          <SurfaceInset className="border-dashed p-3 text-sm text-muted-foreground">
            No imported statement found for this user yet. Import/connect a statement to unlock portfolio-based debate inputs.
          </SurfaceInset>
        ) : (
          <>
            <SurfaceInset className="p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Overall readiness</span>
                <span className="font-semibold text-foreground">
                  {Math.round(snapshot?.readinessScore || 0)} / 100
                </span>
              </div>
              <Progress value={snapshot?.readinessScore || 0} className="mt-2 h-2" />
            </SurfaceInset>

            <DebateReadinessChart
              data={coverageRows.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.value,
              }))}
              className="h-[236px] w-full"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              {coverageRows.map((row) => (
                <SurfaceInset key={row.key} className="p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">{row.label}</span>
                    <span className="text-muted-foreground">{Math.round(row.value)}%</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
                </SurfaceInset>
              ))}
            </div>
          </>
        )}

        <SurfaceInset className="p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Quick Start
          </p>
          {quickStartTickers.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {quickStartTickers.slice(0, 20).map((symbol) => (
                <Button
                  key={symbol}
                  variant="none"
                  effect="fade"
                  size="sm"
                  className="h-7 rounded-full px-2.5 text-xs"
                  onClick={() => onSelectTicker(symbol)}
                >
                  {symbol}
                </Button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No eligible symbols yet. Import a statement first.
            </p>
          )}
        </SurfaceInset>

        {exclusionSummary.length > 0 ? (
          <SurfaceInset className="p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Exclusion Reasons
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {exclusionSummary.map((row) => (
                <span
                  key={row.reason}
                  className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1"
                >
                  {row.reason.replace(/_/g, " ")}: {row.count}
                </span>
              ))}
            </div>
          </SurfaceInset>
        ) : null}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function AnalysisHistoryDashboard({
  userId,
  vaultKey,
  vaultOwnerToken,
  onSelectTicker,
  onViewHistory,
  showDebateInputs = true,
}: AnalysisHistoryDashboardProps) {
  const [entries, setEntries] = useState<HistoryEntryWithVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [debateSnapshot, setDebateSnapshot] = useState<DebateInputsSnapshot | null>(null);
  const [debateSnapshotLoading, setDebateSnapshotLoading] = useState(true);

  const [historyMap, setHistoryMap] = useState<AnalysisHistoryMap>({});
  const historyMapRef = useRef<AnalysisHistoryMap>({});
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionsTicker, setVersionsTicker] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteAction>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);

  useEffect(() => {
    historyMapRef.current = historyMap;
  }, [historyMap]);

  const applyHistoryMap = useCallback((nextMap: AnalysisHistoryMap) => {
    historyMapRef.current = nextMap;
    setHistoryMap(nextMap);
    setEntries(processHistory(nextMap));
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const nextMap = await KaiHistoryService.getAllHistory({
        userId,
        vaultKey,
        vaultOwnerToken,
      });
      applyHistoryMap(nextMap);
    } catch (err) {
      console.error("[AnalysisHistoryDashboard] Failed to load history:", err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [applyHistoryMap, userId, vaultKey, vaultOwnerToken]);

  const fetchDebateSnapshot = useCallback(async () => {
    try {
      setDebateSnapshotLoading(true);
      const initialTickerRows = getTickerUniverseSnapshot() || [];
      let tickerSectorLookup = buildTickerSectorLookup(initialTickerRows);
      if (tickerSectorLookup.size === 0) {
        try {
          const cachedRows = await preloadTickerUniverse();
          tickerSectorLookup = buildTickerSectorLookup(cachedRows);
          if (tickerSectorLookup.size === 0) {
            const freshRows = await preloadTickerUniverse({ forceRefresh: true });
            tickerSectorLookup = buildTickerSectorLookup(freshRows);
          }
        } catch {
          // Keep fallback coverage if ticker-universe preload fails.
        }
      }

      const cache = CacheService.getInstance();
      const cachedPortfolio =
        cache.get<PortfolioData>(CACHE_KEYS.PORTFOLIO_DATA(userId)) ??
        cache.get<PortfolioData>(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
      if (cachedPortfolio && Array.isArray(cachedPortfolio.holdings)) {
        setDebateSnapshot(buildDebateInputsSnapshot(cachedPortfolio, tickerSectorLookup));
        return;
      }

      const financialDomain = await PersonalKnowledgeModelService.loadDomainData({
        userId,
        domain: "financial",
        vaultKey,
        vaultOwnerToken,
      });

      const portfolioCandidate = financialDomain && isRecord(financialDomain.portfolio)
        ? financialDomain.portfolio
        : financialDomain;

      if (!isRecord(portfolioCandidate) || !Array.isArray(portfolioCandidate.holdings)) {
        setDebateSnapshot({
          hasPortfolio: false,
          eligibleSymbols: [],
          coverageRows: [],
          readinessScore: 0,
          exclusionSummary: [],
        });
        return;
      }

      const snapshot = buildDebateInputsSnapshot(
        portfolioCandidate as unknown as PortfolioData,
        tickerSectorLookup
      );
      setDebateSnapshot(snapshot);
    } catch (err) {
      console.warn("[AnalysisHistoryDashboard] Failed to load debate inputs context:", err);
      setDebateSnapshot({
        hasPortfolio: false,
        eligibleSymbols: [],
        coverageRows: [],
        readinessScore: 0,
        exclusionSummary: [],
      });
    } finally {
      setDebateSnapshotLoading(false);
    }
  }, [userId, vaultKey, vaultOwnerToken]);

  // ----- Delete Handlers -----

  const executeDeleteEntry = useCallback(async (entry: AnalysisHistoryEntry) => {
    const { nextMap, changed } = removeEntryFromHistoryMap(historyMap, entry);
    if (!changed) {
      toast.error("Failed to delete analysis");
      return;
    }
    const previousMap = historyMap;
    applyHistoryMap(nextMap);

    const toastId = toast.loading("Deleting analysis entry...");
    setDeleteInFlight(true);
    const streamId = extractEntryStreamId(entry);
    const success = await KaiHistoryService.deleteEntry({
      userId,
      vaultKey,
      vaultOwnerToken,
      ticker: entry.ticker,
      timestamp: entry.timestamp,
      streamId,
    });
    setDeleteInFlight(false);

    if (success) {
      toast.success("Analysis deleted", { id: toastId });
      return;
    }

    applyHistoryMap(previousMap);
    toast.error("Failed to delete analysis", { id: toastId });
  }, [applyHistoryMap, historyMap, userId, vaultKey, vaultOwnerToken]);

  const executeDeleteTicker = useCallback(async (ticker: string) => {
    const canonicalTicker = String(ticker || "").trim().toUpperCase();
    if (!canonicalTicker || canonicalTicker === "UNDEFINED" || canonicalTicker === "NULL") {
      toast.error("Failed to delete history: invalid ticker");
      return;
    }
    const { nextMap, changed, tickerKey } = removeTickerFromHistoryMap(historyMap, canonicalTicker);
    if (!changed || !tickerKey) {
      toast.error(`Failed to delete history for ${canonicalTicker}`);
      return;
    }
    const previousMap = historyMap;
    applyHistoryMap(nextMap);

    const toastId = toast.loading(`Deleting history for ${canonicalTicker}...`);
    setDeleteInFlight(true);
    const success = await KaiHistoryService.deleteTickerHistory({
      userId,
      vaultKey,
      vaultOwnerToken,
      ticker: canonicalTicker,
    });
    setDeleteInFlight(false);

    if (success) {
      toast.success(`All history for ${canonicalTicker} deleted`, { id: toastId });
    } else {
      applyHistoryMap(previousMap);
      toast.error(`Failed to delete history for ${canonicalTicker}`, { id: toastId });
    }
  }, [applyHistoryMap, historyMap, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    return DebateRunManagerService.subscribeHistory((entry, task) => {
      if (task.userId !== userId) return;
      const nextMap = upsertEntryInHistoryMap(historyMapRef.current, entry);
      applyHistoryMap(nextMap);
    });
  }, [applyHistoryMap, userId]);

  const handleDeleteEntry = useCallback((entry: AnalysisHistoryEntry) => {
    setPendingDelete({ kind: "entry", entry });
  }, []);

  const handleDeleteTicker = useCallback((ticker: string) => {
    setPendingDelete({ kind: "ticker", ticker });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleteInFlight) return;
    if (pendingDelete.kind === "entry") {
      await executeDeleteEntry(pendingDelete.entry);
      setPendingDelete(null);
      return;
    }
    await executeDeleteTicker(pendingDelete.ticker);
    setPendingDelete(null);
  }, [pendingDelete, deleteInFlight, executeDeleteEntry, executeDeleteTicker]);

  // ----- Columns -----
  const openVersions = useCallback((ticker: string) => {
    setVersionsTicker(ticker);
    setVersionsOpen(true);
  }, []);

  const columns = getColumns({
    onView: onViewHistory,
    onDelete: handleDeleteEntry,
    onDeleteTicker: handleDeleteTicker,
    onViewVersions: openVersions,
  });

  const versionsForTicker: HistoryEntryWithVersion[] = useMemo(() => {
    if (!versionsTicker) return [];
    const list = historyMap[versionsTicker] || [];

    // Oldest -> newest for version numbering
    const sortedAsc = [...list].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const withVersions = sortedAsc.map((entry, index) => ({
      ...entry,
      version: index + 1,
    }));

    // Show newest first in the modal
    return withVersions.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [historyMap, versionsTicker]);

  useEffect(() => {
    if (userId && vaultKey) {
      fetchHistory();
      if (showDebateInputs) {
        void fetchDebateSnapshot();
      }
    } else {
      setLoading(false);
      setDebateSnapshotLoading(false);
    }
  }, [userId, vaultKey, fetchDebateSnapshot, fetchHistory, showDebateInputs]);

  const historyTickers = useMemo(() => {
    const unique = new Set<string>();
    for (const row of entries) {
      const ticker = String(row.ticker || "").trim().toUpperCase();
      if (!ticker || ticker === "UNDEFINED" || ticker === "NULL") continue;
      unique.add(ticker);
      if (unique.size >= 20) break;
    }
    return Array.from(unique);
  }, [entries]);

  // ----- Loading state -----
  if (loading) {
    return (
      <div className="w-full pb-safe">
        <div className="flex min-h-52 items-center justify-center rounded-2xl border border-border/40 bg-card/60">
          <HushhLoader variant="inline" label="Loading analysis history…" />
        </div>
      </div>
    );
  }

  // ----- Empty state -----
  if (entries.length === 0) {
    return (
      <div className="w-full space-y-6 pb-safe">
        <EmptyState />
        {showDebateInputs ? (
          <DebateInputsCard
            loading={debateSnapshotLoading}
            snapshot={debateSnapshot}
            onSelectTicker={onSelectTicker}
            historyTickers={historyTickers}
          />
        ) : null}
      </div>
    );
  }

  // ----- Populated state -----
  return (
    <div className="w-full space-y-6 pb-safe">
      {/* Header (search is global in Kai layout) */}
      <div className="flex items-center gap-2">
        <Icon icon={Search} size="sm" className="text-muted-foreground" />
        <h2 className="app-section-heading text-muted-foreground uppercase tracking-[0.12em]">
          Analysis History
        </h2>
        <Badge variant="secondary" className="text-[10px]">
          {entries.length}
        </Badge>
      </div>

      {/* Data Table */}
      <DataTable
        columns={columns}
        data={entries}
        searchKey="ticker"
        searchPlaceholder="Search analysis history by ticker..."
        enableSearch
        filterKey="decision"
        filterOptions={[
          { label: "Buy", value: "buy" },
          { label: "Hold / Watch", value: "hold" },
          { label: "Reduce", value: "reduce" },
        ]}
        tableContainerClassName="rounded-[22px] border-border/60 bg-background/60"
        tableClassName="min-w-[640px]"
      />

      {showDebateInputs ? (
        <DebateInputsCard
          loading={debateSnapshotLoading}
          snapshot={debateSnapshot}
          onSelectTicker={onSelectTicker}
          historyTickers={historyTickers}
        />
      ) : null}

      {/* Versions Modal */}
      <Dialog
        open={versionsOpen}
        onOpenChange={(open) => {
          setVersionsOpen(open);
          if (!open) setVersionsTicker(null);
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md sm:w-full">
          <DialogHeader>
            <DialogTitle>
              {versionsTicker ? `${versionsTicker} — Previous Versions` : "Previous Versions"}
            </DialogTitle>
          </DialogHeader>

          {versionsForTicker.length === 0 ? (
            <div className="text-sm text-muted-foreground">No previous versions found.</div>
          ) : (
            <div className="space-y-2">
              {versionsForTicker.map((entry) => {
                const rawCard =
                  entry.raw_card && typeof entry.raw_card === "object"
                    ? (entry.raw_card as Record<string, unknown>)
                    : null;
                const ownsPosition =
                  typeof rawCard?.owns_position === "boolean"
                    ? rawCard.owns_position
                    : typeof rawCard?.is_position_owned === "boolean"
                      ? rawCard.is_position_owned
                      : null;
                const styles = decisionStyles(entry.decision, ownsPosition);
                const ts = entry.timestamp ? new Date(entry.timestamp) : null;

                return (
                  <div
                    key={`${entry.ticker}-${entry.timestamp}`}
                    className="flex items-center gap-2"
                  >
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      showRipple={false}
                      className="min-w-0 flex-1 justify-between h-auto py-3 px-3 border border-transparent hover:border-border/40"
                      onClick={() => {
                        onViewHistory(entry);
                        setVersionsOpen(false);
                        setVersionsTicker(null);
                      }}
                    >
                      <div className="flex min-w-0 flex-col items-start gap-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">v{entry.version}</span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                              styles.bg,
                              styles.text,
                              styles.border
                            )}
                          >
                            {styles.icon}
                            {styles.label}
                          </span>
                        </div>
                        <span className="truncate text-xs text-muted-foreground">
                          {ts ? format(ts, "PPpp") : ""}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">Open</span>
                    </Button>
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="icon-sm"
                      showRipple={false}
                      className="h-9 w-9 shrink-0 border border-transparent text-red-600 hover:border-red-500/30 hover:bg-red-500/10 dark:text-red-400"
                      onClick={() => setPendingDelete({ kind: "entry", entry })}
                      title="Delete this version"
                    >
                      <Icon icon={Trash2} size="sm" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleteInFlight) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.kind === "ticker" ? "Delete all versions?" : "Delete this version?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "ticker"
                ? `This will remove all saved analysis versions for ${pendingDelete.ticker}.`
                : "This will permanently remove the selected analysis version from history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteInFlight}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              disabled={deleteInFlight}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleteInFlight ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting...
                </span>
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

export default AnalysisHistoryDashboard;
