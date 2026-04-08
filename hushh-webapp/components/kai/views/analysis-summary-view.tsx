"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Scale } from "lucide-react";
import { APP_MEASURE_STYLES } from "@/components/app-ui/app-page-shell";

import { Button } from "@/lib/morphy-ux/button";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { Badge } from "@/components/ui/badge";
import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import { cn } from "@/lib/utils";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";
import {
  fetchLatestMarketSnapshot,
  getLatestMarketSnapshotFromCache,
  pickPreferredMarketSnapshot,
  type TickerMarketSnapshot,
} from "@/lib/kai/market-snapshot";

interface AnalysisSummaryViewProps {
  entry: AnalysisHistoryEntry;
  onBack?: () => void;
  onOpenDebate?: () => void;
  onReanalyze?: (ticker: string) => void;
  embedded?: boolean;
  userId?: string;
  vaultOwnerToken?: string;
  showHeader?: boolean;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace("%", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickString(values: unknown[], fallback: string): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function formatCurrency(value: number | null): string {
  if (value === null) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Updated recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Updated recently";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function resolveOwnsPosition(entry: AnalysisHistoryEntry, userId?: string): boolean | null {
  const rawCard = (entry.raw_card || {}) as Record<string, unknown>;
  const directFlags = [rawCard.owns_position, rawCard.is_position_owned, rawCard.in_portfolio];
  for (const flag of directFlags) {
    if (typeof flag === "boolean") return flag;
  }
  if (!userId) return null;

  const cache = CacheService.getInstance();
  const cachedPortfolio =
    cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(userId)) ??
    cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
  const holdingsRaw =
    cachedPortfolio && Array.isArray(cachedPortfolio.holdings)
      ? cachedPortfolio.holdings
      : cachedPortfolio &&
          cachedPortfolio.portfolio &&
          typeof cachedPortfolio.portfolio === "object" &&
          !Array.isArray(cachedPortfolio.portfolio) &&
          Array.isArray((cachedPortfolio.portfolio as Record<string, unknown>).holdings)
        ? ((cachedPortfolio.portfolio as Record<string, unknown>).holdings as unknown[])
        : [];
  const targetTicker = String(entry.ticker || "").trim().toUpperCase();
  if (!targetTicker) return null;
  const found = holdingsRaw.some((row) => {
    if (!row || typeof row !== "object") return false;
    const symbol = String((row as Record<string, unknown>).symbol || "")
      .trim()
      .toUpperCase();
    return symbol === targetTicker;
  });
  return found;
}

function resolveCurrentPrice(rawCard: Record<string, unknown>): number | null {
  const marketSnapshotRaw =
    rawCard.market_snapshot &&
    typeof rawCard.market_snapshot === "object" &&
    !Array.isArray(rawCard.market_snapshot)
      ? (rawCard.market_snapshot as Record<string, unknown>)
      : {};
  const keyMetricsRaw =
    rawCard.key_metrics &&
    typeof rawCard.key_metrics === "object" &&
    !Array.isArray(rawCard.key_metrics)
      ? (rawCard.key_metrics as Record<string, unknown>)
      : {};
  const valuationRaw =
    keyMetricsRaw.valuation &&
    typeof keyMetricsRaw.valuation === "object" &&
    !Array.isArray(keyMetricsRaw.valuation)
      ? (keyMetricsRaw.valuation as Record<string, unknown>)
      : {};
  const priceTargetsRaw =
    rawCard.price_targets &&
    typeof rawCard.price_targets === "object" &&
    !Array.isArray(rawCard.price_targets)
      ? (rawCard.price_targets as Record<string, unknown>)
      : {};

  return (
    readNumber(marketSnapshotRaw.last_price) ??
    readNumber(rawCard.current_price) ??
    readNumber(valuationRaw.current_price) ??
    readNumber(valuationRaw.price) ??
    readNumber(priceTargetsRaw.current_price) ??
    readNumber(priceTargetsRaw.current) ??
    readNumber(priceTargetsRaw.market_price)
  );
}

function resolveDailyChangePct(rawCard: Record<string, unknown>): number | null {
  const marketSnapshotRaw =
    rawCard.market_snapshot &&
    typeof rawCard.market_snapshot === "object" &&
    !Array.isArray(rawCard.market_snapshot)
      ? (rawCard.market_snapshot as Record<string, unknown>)
      : {};
  const keyMetricsRaw =
    rawCard.key_metrics &&
    typeof rawCard.key_metrics === "object" &&
    !Array.isArray(rawCard.key_metrics)
      ? (rawCard.key_metrics as Record<string, unknown>)
      : {};
  const sentimentRaw =
    keyMetricsRaw.sentiment &&
    typeof keyMetricsRaw.sentiment === "object" &&
    !Array.isArray(keyMetricsRaw.sentiment)
      ? (keyMetricsRaw.sentiment as Record<string, unknown>)
      : {};

  return (
    readNumber(marketSnapshotRaw.change_pct) ??
    readNumber(rawCard.day_change_pct) ??
    readNumber(rawCard.todays_change_pct) ??
    readNumber(sentimentRaw.day_change_pct)
  );
}

function resolveRawCardMarketSnapshot(
  rawCard: Record<string, unknown>,
  fallbackObservedAt?: string
): TickerMarketSnapshot | null {
  const marketSnapshotRaw =
    rawCard.market_snapshot &&
    typeof rawCard.market_snapshot === "object" &&
    !Array.isArray(rawCard.market_snapshot)
      ? (rawCard.market_snapshot as Record<string, unknown>)
      : {};
  const direct = readNumber(marketSnapshotRaw.last_price);
  if (direct !== null && direct > 0) {
    return {
      last_price: direct,
      change_pct: readNumber(marketSnapshotRaw.change_pct),
      observed_at:
        (typeof marketSnapshotRaw.observed_at === "string" && marketSnapshotRaw.observed_at) ||
        fallbackObservedAt ||
        null,
      source:
        (typeof marketSnapshotRaw.source === "string" && marketSnapshotRaw.source) ||
        "decision_payload.market_snapshot",
    };
  }

  const fallback = resolveCurrentPrice(rawCard);
  if (fallback !== null && fallback > 0) {
    return {
      last_price: fallback,
      change_pct: resolveDailyChangePct(rawCard),
      observed_at: fallbackObservedAt || null,
      source: "decision_payload.fallback",
    };
  }

  return null;
}

function ScoreBar({
  label,
  description,
  value,
  valueLabel,
  tone,
}: {
  label: string;
  description: string;
  value: number | null;
  valueLabel?: string;
  tone: "neutral" | "positive" | "warning";
}) {
  const clamped = value === null ? null : Math.max(0, Math.min(10, value));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-sm font-bold tabular-nums">
          {valueLabel || (clamped === null ? "N/A" : `${clamped.toFixed(1)} / 10`)}
        </p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            tone === "positive" && "bg-emerald-500",
            tone === "warning" && "bg-blue-500",
            tone === "neutral" && "bg-zinc-900 dark:bg-zinc-100"
          )}
          style={{ width: `${clamped === null ? 0 : clamped * 10}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

export function AnalysisSummaryView({
  entry,
  onBack,
  onOpenDebate,
  onReanalyze,
  embedded = false,
  userId,
  vaultOwnerToken,
  showHeader = true,
}: AnalysisSummaryViewProps) {
  const rawCard = useMemo(
    () =>
      entry.raw_card && typeof entry.raw_card === "object"
        ? (entry.raw_card as Record<string, unknown>)
        : {},
    [entry.raw_card]
  );
  const entryRecord = entry as unknown as Record<string, unknown>;
  const rawCardSnapshot = useMemo(
    () =>
      resolveRawCardMarketSnapshot(
        rawCard,
        String(rawCard.analysis_updated_at || entry.timestamp || "")
      ),
    [entry.timestamp, rawCard]
  );
  const [marketSnapshot, setMarketSnapshot] = useState<TickerMarketSnapshot | null>(
    rawCardSnapshot
  );

  useEffect(() => {
    setMarketSnapshot(rawCardSnapshot);
  }, [rawCardSnapshot, entry.ticker]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const cached = getLatestMarketSnapshotFromCache(userId, entry.ticker);
    if (!cancelled) {
      setMarketSnapshot((prev) => pickPreferredMarketSnapshot(prev, cached));
    }

    if (!vaultOwnerToken) return () => {
      cancelled = true;
    };

    void (async () => {
      try {
        const live = await fetchLatestMarketSnapshot({
          userId,
          ticker: entry.ticker,
          vaultOwnerToken,
          daysBack: 7,
        });
        if (!cancelled) {
          setMarketSnapshot((prev) => pickPreferredMarketSnapshot(prev, live));
        }
      } catch {
        // Non-blocking: keep best known snapshot.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entry.ticker, userId, vaultOwnerToken]);

  const companyStrength = readNumber(rawCard.company_strength_score);
  const marketTrendScore = readNumber(rawCard.market_trend_score);
  const fairValueScore = readNumber(rawCard.fair_value_score);
  const fairValueGapPct = readNumber(rawCard.fair_value_gap_pct);
  const marketTrendLabel = String(rawCard.market_trend_label || "Trend unavailable");
  const fairValueLabel = String(rawCard.fair_value_label || "Fair value unavailable");
  const currentPrice = marketSnapshot?.last_price ?? resolveCurrentPrice(rawCard);
  const todayChangePct = marketSnapshot?.change_pct ?? resolveDailyChangePct(rawCard);
  const priceLabel = formatCurrency(currentPrice);
  const fairValueGapLabel =
    fairValueGapPct === null
      ? null
      : `${fairValueGapPct >= 0 ? "+" : ""}${fairValueGapPct.toFixed(1)}% gap`;
  const companyStrengthDetail = pickString(
    [
      (rawCard.fundamental_insight as Record<string, unknown> | undefined)?.summary,
      entryRecord.fundamental_summary,
      entry.final_statement,
    ],
    "Company fundamentals summary is being refreshed."
  );
  const marketTrendDetail = pickString(
    [entryRecord.sentiment_summary, rawCard.debate_digest, entry.final_statement],
    "Market trend context is being refreshed."
  );
  const fairValueDetail = pickString(
    [entryRecord.valuation_summary, rawCard.debate_digest, entry.final_statement],
    "Fair value context is being refreshed."
  );
  const shortRecommendation = String(
    rawCard.short_recommendation || entry.final_statement || "Recommendation unavailable."
  );
  const updatedAt = formatTimestamp(String(rawCard.analysis_updated_at || entry.timestamp || ""));
  const ownsPosition = useMemo(() => resolveOwnsPosition(entry, userId), [entry, userId]);
  const decisionPresentation = useMemo(
    () => toInvestorDecisionLabel(entry.decision, ownsPosition),
    [entry.decision, ownsPosition]
  );
  const decisionToneClass =
    decisionPresentation.tone === "positive"
      ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : decisionPresentation.tone === "negative"
        ? "bg-rose-500/12 text-rose-600 dark:text-rose-400 border-rose-500/30"
        : "bg-blue-500/12 text-blue-600 dark:text-blue-400 border-blue-500/30";

  return (
    <div className="mx-auto w-full space-y-4 pb-safe pt-1" style={APP_MEASURE_STYLES.reading}>
      {!embedded ? (
        <div className="flex items-center justify-between gap-3">
          <Button variant="none" effect="fade" size="sm" onClick={onBack} disabled={!onBack}>
            <Icon icon={ArrowLeft} size="sm" className="mr-1" />
            History
          </Button>
          <Button
            variant="none"
            effect="fade"
            size="sm"
            onClick={() => onReanalyze?.(entry.ticker)}
            disabled={!onReanalyze}
          >
            <Icon icon={RefreshCw} size="sm" className="mr-1" />
            Re-analyze
          </Button>
        </div>
      ) : null}

      {showHeader ? (
        <div className="flex items-center gap-4 px-1">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-black text-lg font-black text-white dark:bg-white dark:text-black">
            {entry.ticker.slice(0, 1)}
          </div>
          <div>
            <h2 className="text-2xl font-black tracking-tight leading-tight">{entry.ticker} Insight</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">{priceLabel}</span>
              {todayChangePct !== null ? (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs font-semibold",
                    todayChangePct >= 0
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  )}
                >
                  Today {todayChangePct >= 0 ? "+" : ""}
                  {todayChangePct.toFixed(2)}%
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Today's status unavailable</span>
              )}
              {fairValueGapLabel ? (
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  {fairValueGapLabel}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <Card variant="none" effect="glass" preset="hero">
        <CardContent className="space-y-5 p-6">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-bold uppercase tracking-widest text-primary">Analysis</span>
            <span className="text-xs font-medium text-muted-foreground">{updatedAt}</span>
          </div>

          <div className="rounded-2xl border border-border/60 bg-background/60 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Overall Decision
              </p>
              <Badge variant="outline" className={decisionToneClass}>
                {decisionPresentation.label}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{decisionPresentation.guidance}</p>
          </div>

          <ScoreBar
            label="Company Strength"
            value={companyStrength}
            tone="neutral"
            description={companyStrengthDetail}
          />

          <ScoreBar
            label="Market Trend"
            value={marketTrendScore}
            valueLabel={marketTrendLabel}
            tone="positive"
            description={marketTrendDetail}
          />

          <ScoreBar
            label="Fair Value"
            value={fairValueScore}
            valueLabel={fairValueLabel}
            tone="warning"
            description={fairValueDetail}
          />
        </CardContent>
      </Card>

      <Card variant="muted" effect="fill" preset="default">
        <CardContent className="space-y-3 p-4">
          <div className="border-l-2 border-primary pl-3">
            <p className="text-sm font-medium leading-relaxed">{shortRecommendation}</p>
            <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Kai Insight
            </p>
          </div>
          {!embedded && onOpenDebate ? (
            <Button variant="blue-gradient" effect="fill" size="sm" onClick={onOpenDebate}>
              <Icon icon={Scale} size="sm" className="mr-1" />
              Open Detailed Debate
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
