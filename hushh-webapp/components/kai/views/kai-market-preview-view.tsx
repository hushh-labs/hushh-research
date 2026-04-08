"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  ChartColumnIncreasing,
  Cpu,
  ExternalLink,
  LineChart,
  Loader2,
  Newspaper,
  Percent,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
  Zap,
} from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceInset,
  SurfaceStack,
  surfaceInteractiveShellClassName,
} from "@/components/app-ui/surfaces";
import { ConnectPortfolioCta } from "@/components/kai/cards/connect-portfolio-cta";
import { MarketOverviewGrid, type MarketOverviewMetric } from "@/components/kai/cards/market-overview-grid";
import { RiaPicksList } from "@/components/kai/cards/renaissance-market-list";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { ThemeFocusList, type ThemeFocusItem } from "@/components/kai/cards/theme-focus-list";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  KaiFinancialResourceService,
  useKaiFinancialResource,
} from "@/lib/kai/kai-financial-resource";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { ensureKaiVaultOwnerToken } from "@/lib/services/kai-token-guard";
import {
  type KaiHomeInsightsV2,
  type KaiHomeNewsItem,
  type KaiHomePickSource,
  type KaiHomeSignal,
  type KaiHomeRenaissanceItem,
  type KaiHomeWatchlistItem,
} from "@/lib/services/api-service";
import {
  getKaiActivePickSource,
  setKaiActivePickSource,
} from "@/lib/kai/pick-source-selection";
import { assignWindowLocation, openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

function normalizeTrackedSymbols(symbols: string[] | null | undefined): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((symbol) => String(symbol || "").trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol, index, arr) => arr.indexOf(symbol) === index)
    .slice(0, 8);
}

const THEME_ICON_MAP: Array<{ test: RegExp; icon: LucideIcon }> = [
  { test: /ai|chip|semi|data|cloud|infra/i, icon: Cpu },
  { test: /rate|yield|inflation|macro/i, icon: Percent },
  { test: /energy|oil|gas|renewable|power/i, icon: Zap },
];

function toSpotlightDecision(input: string | undefined): "BUY" | "HOLD" | "REDUCE" {
  const text = String(input || "").trim().toUpperCase();
  if (text === "BUY" || text === "STRONG_BUY") return "BUY";
  if (text === "REDUCE" || text === "SELL") return "REDUCE";
  return "HOLD";
}

function isWeakSpotlightDetail(input: string | null | undefined): boolean {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return true;
  return (
    text.includes("no live recommendation feed available") ||
    text.includes("recommendation unavailable") ||
    text.includes("target consensus unavailable")
  );
}

function toSafeHttpUrl(input: string | null | undefined): string | null {
  const text = String(input || "").trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  return text;
}

function summarizeSpotlight(row: NonNullable<KaiHomeInsightsV2["spotlights"]>[number]): string {
  const story = String(row.story || "").trim();
  if (story) return story;

  const detail = String(row.recommendation_detail || "").trim();
  if (detail && !isWeakSpotlightDetail(detail)) return detail;

  const headline = String(row.headline || "").trim();
  if (headline) return `Recent coverage: ${headline}`;

  const decision = toSpotlightDecision(row.recommendation);
  const changePct =
    typeof row.change_pct === "number" && Number.isFinite(row.change_pct)
      ? `${row.change_pct >= 0 ? "+" : ""}${row.change_pct.toFixed(2)}% today`
      : null;
  if (decision === "BUY") {
    return changePct
      ? `Momentum is positive (${changePct}) while analyst updates refresh.`
      : "Momentum is positive while analyst updates refresh.";
  }
  if (decision === "REDUCE") {
    return changePct
      ? `Momentum is soft (${changePct}) while analyst updates refresh.`
      : "Momentum is soft while analyst updates refresh.";
  }
  return changePct
    ? `Price action is mixed (${changePct}) while analyst updates refresh.`
    : "Price action is mixed while analyst updates refresh.";
}

function spotlightContextLabel(row: NonNullable<KaiHomeInsightsV2["spotlights"]>[number]): string {
  const source = String(row.headline_source || "").trim();
  if (source) return source;
  const recommendationSource = String(row.recommendation_source || "").trim();
  if (recommendationSource) return recommendationSource;
  return "Market signal feed";
}

function spotlightConfidenceLabel(
  row: NonNullable<KaiHomeInsightsV2["spotlights"]>[number]
): string | null {
  const value = row.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return `${pct}% confidence`;
}

function signalConfidenceLabel(signal: {
  confidence?: number | null;
}): string {
  const value = signal.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return "Signal";
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return `${pct}% confidence`;
}

function signalConfidenceTone(signal: {
  confidence?: number | null;
  degraded?: boolean;
}): string {
  if (signal.degraded) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  const value =
    typeof signal.confidence === "number" && Number.isFinite(signal.confidence)
      ? signal.confidence
      : 0;
  if (value >= 0.72) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  return "bg-[var(--app-card-surface-compact)] text-muted-foreground";
}

function visibleSignalSourceTags(signal: KaiHomeSignal | undefined): string[] {
  if (!Array.isArray(signal?.source_tags)) return [];
  return signal.source_tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .filter((tag) => !/fallback|unavailable|cache|derived/i.test(tag));
}

function deriveSignalSupportingItems(
  signal:
    | (KaiHomeSignal & {
        supporting_items?: Array<{ symbol?: string; company_name?: string }>;
      })
    | undefined,
  pickRows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): Array<{ symbol: string; company_name?: string }> {
  const directItems = Array.isArray(signal?.supporting_items)
    ? signal.supporting_items
        .map((item) => ({
          symbol: String(item?.symbol || "").trim().toUpperCase(),
          company_name: String(item?.company_name || "").trim() || undefined,
        }))
        .filter((item) => item.symbol)
    : [];
  if (directItems.length > 0) return directItems.slice(0, 4);

  const signalId = String(signal?.id || "").trim().toLowerCase();
  const title = String(signal?.title || "").trim().toUpperCase();
  if (signalId !== "recommendation-consensus" && !title.endsWith("TILT")) return [];

  const dominantRecommendation = title.replace(/\s+TILT$/, "").trim();
  if (!dominantRecommendation) return [];

  const normalizeRecommendationFamily = (value: string): string => {
    const normalized = value.trim().toUpperCase();
    if (
      normalized === "BUY" ||
      normalized === "STRONG_BUY" ||
      normalized === "BULLISH" ||
      normalized === "HOLD_TO_BUY"
    ) {
      return "BUY";
    }
    if (
      normalized === "REDUCE" ||
      normalized === "SELL" ||
      normalized === "BEARISH"
    ) {
      return "REDUCE";
    }
    if (normalized === "HOLD" || normalized === "NEUTRAL" || normalized === "WATCH") {
      return "HOLD";
    }
    return normalized;
  };

  const rowRecommendation = (row: KaiHomeWatchlistItem | KaiHomeRenaissanceItem): string => {
    if ("recommendation" in row && typeof row.recommendation === "string") {
      return normalizeRecommendationFamily(row.recommendation);
    }
    if ("recommendation_bias" in row && typeof row.recommendation_bias === "string") {
      return normalizeRecommendationFamily(row.recommendation_bias);
    }
    return "";
  };

  return pickRows
    .filter((row) => rowRecommendation(row) === normalizeRecommendationFamily(dominantRecommendation))
    .sort((left, right) => {
      const leftDegraded = Boolean(left.degraded) ? 1 : 0;
      const rightDegraded = Boolean(right.degraded) ? 1 : 0;
      if (leftDegraded !== rightDegraded) return leftDegraded - rightDegraded;
      const leftChange = Math.abs(Number(left.change_pct || 0));
      const rightChange = Math.abs(Number(right.change_pct || 0));
      return rightChange - leftChange;
    })
    .slice(0, 4)
    .map((row) => ({
      symbol: String(row.symbol || "").trim().toUpperCase(),
      company_name: String(row.company_name || row.symbol || "").trim() || undefined,
    }))
    .filter((item) => item.symbol);
}

function signalDetailGroups(
  signal: KaiHomeSignal | undefined,
  payload: KaiHomeInsightsV2 | null,
  pickRows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): Array<{ label: string; symbols: string[] }> {
  if (!signal) return [];
  const signalId = String(signal.id || "").trim().toLowerCase();

  if (signalId === "breadth") {
    const higher = pickRows
      .filter((row) => typeof row.change_pct === "number" && row.change_pct > 0)
      .sort((left, right) => Math.abs(Number(right.change_pct || 0)) - Math.abs(Number(left.change_pct || 0)))
      .map((row) => String(row.symbol || "").trim().toUpperCase())
      .filter(Boolean);
    const lower = pickRows
      .filter((row) => typeof row.change_pct === "number" && row.change_pct < 0)
      .sort((left, right) => Math.abs(Number(right.change_pct || 0)) - Math.abs(Number(left.change_pct || 0)))
      .map((row) => String(row.symbol || "").trim().toUpperCase())
      .filter(Boolean);
    return [
      higher.length ? { label: "Higher today", symbols: higher } : null,
      lower.length ? { label: "Lower today", symbols: lower } : null,
    ].filter((group): group is { label: string; symbols: string[] } => Boolean(group));
  }

  if (signalId === "recommendation-consensus") {
    const title = String(signal.title || "").trim().toUpperCase();
    const dominantRecommendation = title.replace(/\s+TILT$/, "").trim();
    const supporting = pickRows
      .filter((row) => {
        const recommendation =
          "recommendation" in row && typeof row.recommendation === "string"
            ? row.recommendation
            : "recommendation_bias" in row && typeof row.recommendation_bias === "string"
              ? row.recommendation_bias
              : "";
        const normalized = recommendation.trim().toUpperCase();
        if (
          dominantRecommendation === "BUY" &&
          ["BUY", "STRONG_BUY", "BULLISH", "HOLD_TO_BUY"].includes(normalized)
        ) {
          return true;
        }
        if (
          dominantRecommendation === "REDUCE" &&
          ["REDUCE", "SELL", "BEARISH"].includes(normalized)
        ) {
          return true;
        }
        if (
          dominantRecommendation === "HOLD" &&
          ["HOLD", "NEUTRAL", "WATCH"].includes(normalized)
        ) {
          return true;
        }
        return normalized === dominantRecommendation;
      })
      .sort((left, right) => Math.abs(Number(right.change_pct || 0)) - Math.abs(Number(left.change_pct || 0)))
      .map((row) => String(row.symbol || "").trim().toUpperCase())
      .filter(Boolean);
    return supporting.length ? [{ label: "Buy leaders", symbols: supporting }] : [];
  }

  return [];
}

function signalEvidenceLines(
  signal: KaiHomeSignal | undefined,
  payload: KaiHomeInsightsV2 | null,
  _pickRows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): string[] {
  if (!signal) return [];
  const signalId = String(signal.id || "").trim().toLowerCase();

  if (signalId === "breadth") {
    return [];
  }

  if (signalId === "volatility-regime") {
    const volatilityRow = Array.isArray(payload?.market_overview)
      ? payload.market_overview.find((row) =>
          String(row?.label || "").toLowerCase().includes("volatility")
        )
      : null;
    const volatilityValue =
      volatilityRow && (typeof volatilityRow.value === "number" || typeof volatilityRow.value === "string")
        ? String(volatilityRow.value).trim()
        : "";
    return volatilityValue ? [`VIX spot: ${volatilityValue}`] : [];
  }

  if (signalId === "recommendation-consensus") {
    return [];
  }

  return [];
}

function signalHeadlineLabel(signal: KaiHomeSignal | undefined): string {
  const signalId = String(signal?.id || "").trim().toLowerCase();
  if (signalId === "breadth") return "Tape read";
  if (signalId === "volatility-regime") return "Risk condition";
  if (signalId === "recommendation-consensus") return "Watchlist leaning";
  return "Signal";
}

function signalAccentClass(signal: KaiHomeSignal | undefined): string {
  const signalId = String(signal?.id || "").trim().toLowerCase();
  if (signalId === "breadth") return "text-muted-foreground";
  if (signalId === "volatility-regime") return "text-amber-700 dark:text-amber-300";
  if (signalId === "recommendation-consensus") return "text-emerald-700 dark:text-emerald-300";
  return "text-muted-foreground";
}

function SignalGroupBlock({
  label,
  symbols,
}: {
  scopeId: string;
  label: string;
  symbols: string[];
}) {
  const top = symbols.slice(0, 5);

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-sm font-semibold text-foreground">
          {symbols.length} names
          {top.length > 0 ? (
            <span className="ml-2 font-normal text-muted-foreground">
              {top.join(", ")}{symbols.length > 5 ? "..." : ""}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

function formatSpotlightPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatHeadlinePublished(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "Recent";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "Recent";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SpotlightFeatureTile({
  row,
}: {
  row: NonNullable<KaiHomeInsightsV2["spotlights"]>[number];
}) {
  const decision = toSpotlightDecision(row.recommendation);
  const primaryHref = toSafeHttpUrl(row.headline_url) || `/kai/analysis?symbol=${encodeURIComponent(row.symbol)}`;
  const _confidenceLabel = spotlightConfidenceLabel(row);
  const summary = summarizeSpotlight(row);
  const context = spotlightContextLabel(row);
  const companyName = String(row.company_name || row.symbol || "Unknown").trim();
  const price = formatSpotlightPrice(row.price);
  const decisionTone =
    decision === "BUY"
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
      : decision === "REDUCE"
        ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
        : "bg-[color:var(--app-card-surface-compact)] text-muted-foreground";

  return (
    <button
      type="button"
      onClick={() => {
        if (/^https?:\/\//i.test(primaryHref)) {
          openExternalUrl(primaryHref);
          return;
        }
        assignWindowLocation(primaryHref);
      }}
      className={cn(
        surfaceInteractiveShellClassName,
        "group relative flex h-full min-h-[200px] flex-col justify-between overflow-hidden rounded-[var(--app-card-radius-feature)] bg-[color:var(--app-card-surface-default-solid)] p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/10 focus-visible:ring-offset-2 sm:p-5"
      )}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <SymbolAvatar symbol={row.symbol} name={row.company_name} size="md" />
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{row.symbol} · {context}</p>
              <h3 className="line-clamp-2 text-lg font-bold tracking-tight leading-tight text-foreground sm:text-xl">
                {companyName}
              </h3>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide",
              decisionTone
            )}
          >
            {decision}
          </span>
        </div>

        <p className="text-2xl font-semibold tracking-tight text-foreground">{price}</p>
        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{summary}</p>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-[color:var(--app-card-border-standard)] pt-3">
        <p className="line-clamp-1 min-w-0 text-xs text-muted-foreground">
          {String(row.headline || summary).trim()}
        </p>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      </div>
    </button>
  );
}

function MarketHeadlinesRail({ rows }: { rows: KaiHomeNewsItem[] }) {
  if (!rows.length) {
    return (
      <SurfaceCard className="h-full">
        <SurfaceCardContent className="flex h-full min-h-[240px] items-center justify-center p-5 text-sm text-muted-foreground">
          No recent market headlines are available right now.
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard className="h-full overflow-hidden">
      <SurfaceCardContent className="flex h-full min-h-[240px] flex-col p-0">
        <div className="flex items-center justify-between gap-3 border-b border-[color:var(--app-card-border-standard)] px-4 py-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Latest coverage
            </p>
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
              Fast reads from the tape
            </h3>
          </div>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-muted-foreground shadow-[var(--shadow-xs)]">
            <Newspaper className="h-4 w-4" />
          </span>
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          <div className="divide-y divide-border/40">
            {rows.slice(0, 8).map((row, index) => (
              <button
                key={`${row.symbol}-${index}-${row.url}`}
                type="button"
                onClick={() => openExternalUrl(row.url)}
                className="group flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-foreground/[0.03]"
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className="border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-2 py-0 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground"
                    >
                      {row.symbol}
                    </Badge>
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      {row.source_name}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[14px] font-medium leading-5 text-foreground">
                    {row.title}
                  </p>
                  <p className="text-[12px] text-muted-foreground">
                    {formatHeadlinePublished(row.published_at)}
                  </p>
                </div>
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors duration-150 group-hover:border-[color:var(--app-card-border-standard)] group-hover:bg-[var(--app-card-surface-compact)] group-hover:text-foreground">
                  <ExternalLink className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function isUnavailableText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "unknown" ||
    normalized === "unavailable" ||
    normalized === "none" ||
    normalized === "null" ||
    normalized === "--" ||
    normalized === "-"
  );
}

function normalizeOverviewSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const text = source.trim();
  if (!text || isUnavailableText(text)) return null;
  return text;
}

function formatOverviewValue(
  value: string | number | null | undefined,
  {
    label,
    degraded,
  }: {
    label: string;
    degraded: boolean;
  }
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) >= 1000) {
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
    }
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "string" && value.trim() && !isUnavailableText(value)) return value;
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes("market status")) {
    return degraded ? "Status delayed" : "Updating status";
  }
  if (lowerLabel.includes("volatility") || lowerLabel.includes("vix")) {
    return degraded ? "Volatility delayed" : "Updating volatility";
  }
  return degraded ? "Data delayed" : "Updating";
}

function formatOverviewDelta(
  deltaPct: number | null | undefined,
  {
    label,
    source,
    degraded,
  }: {
    label: string;
    source: string | null | undefined;
    degraded: boolean;
  }
): string {
  if (typeof deltaPct !== "number" || !Number.isFinite(deltaPct)) {
    const lowerLabel = label.toLowerCase();
    const normalizedSource = normalizeOverviewSource(source);
    if (lowerLabel.includes("market status")) {
      return degraded ? "Schedule fallback" : "Live session";
    }
    if (normalizedSource) {
      return degraded ? `${normalizedSource} delayed` : normalizedSource;
    }
    return degraded ? "Data delayed" : "Live";
  }
  const sign = deltaPct >= 0 ? "+" : "";
  return `${sign}${deltaPct.toFixed(2)}%`;
}

function toOverviewTone(
  deltaPct: number | null | undefined,
  degraded: boolean
): MarketOverviewMetric["tone"] {
  if (typeof deltaPct !== "number" || !Number.isFinite(deltaPct)) {
    return degraded ? "warning" : "neutral";
  }
  if (deltaPct > 0.25) return "positive";
  if (deltaPct < -0.25) return "negative";
  return "neutral";
}

function iconForOverview(label: string, tone: MarketOverviewMetric["tone"]): LucideIcon {
  const lower = label.toLowerCase();
  if (lower.includes("volatility") || lower.includes("vix")) return Activity;
  if (lower.includes("yield") || lower.includes("rate")) return ChartColumnIncreasing;
  if (tone === "positive") return TrendingUp;
  if (tone === "negative") return TrendingDown;
  return LineChart;
}

function findOverviewRow(
  payload: KaiHomeInsightsV2 | null,
  match: (row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number]) => boolean
) {
  const rows = payload?.market_overview;
  if (!Array.isArray(rows)) return null;
  return (
    rows.find(
      (row): row is NonNullable<KaiHomeInsightsV2["market_overview"]>[number] =>
        Boolean(row) && match(row)
    ) ?? null
  );
}

function toIndexOverviewMetric(
  row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null,
  fallbackLabel: string
): MarketOverviewMetric {
  const degraded = !row || Boolean(row.degraded);
  const label = String(row?.label || fallbackLabel);
  const tone = toOverviewTone(row?.delta_pct, degraded);
  return {
    id: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    value: formatOverviewValue(row?.value, { label, degraded }),
    delta: formatOverviewDelta(row?.delta_pct, {
      label,
      source: row?.source,
      degraded,
    }),
    tone,
    icon: iconForOverview(label, tone),
  };
}

function toBreadthMetric(payload: KaiHomeInsightsV2 | null): MarketOverviewMetric {
  const movers = payload?.movers;
  const gainers = Array.isArray(movers?.gainers) ? movers.gainers.length : 0;
  const losers = Array.isArray(movers?.losers) ? movers.losers.length : 0;
  const degraded = Boolean(movers?.degraded) || gainers + losers === 0;
  const spread = gainers - losers;
  const trackedCount = gainers + losers;
  const tone: MarketOverviewMetric["tone"] =
    spread > 0 ? "positive" : spread < 0 ? "negative" : degraded ? "warning" : "neutral";

  let value = "Mixed tape";
  if (spread >= 4) value = "Broad participation";
  if (spread <= -4) value = "Narrow leadership";
  if (degraded && trackedCount === 0) value = "Updating";

  const _topHigher = Array.isArray(movers?.gainers)
    ? movers.gainers
        .map((row) => String(row?.symbol || "").trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const _topLower = Array.isArray(movers?.losers)
    ? movers.losers
        .map((row) => String(row?.symbol || "").trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return {
    id: "breadth",
    label: "Advancers vs decliners",
    value,
    delta:
      trackedCount > 0
        ? `${gainers} of ${trackedCount} tracked names are higher today`
        : degraded
          ? "Breadth snapshot delayed"
          : "Awaiting breadth snapshot",
    tone,
    icon: tone === "negative" ? TrendingDown : TrendingUp,
  };
}

function toSectorLeadershipMetric(payload: KaiHomeInsightsV2 | null): MarketOverviewMetric {
  const sectorRows = Array.isArray(payload?.sector_rotation)
    ? payload.sector_rotation.filter(
        (row): row is NonNullable<KaiHomeInsightsV2["sector_rotation"]>[number] =>
          Boolean(row) && typeof row.change_pct === "number" && Number.isFinite(row.change_pct)
      )
    : [];
  const leader = [...sectorRows].sort(
    (left, right) => Number(right.change_pct || 0) - Number(left.change_pct || 0)
  )[0];
  const degraded = !leader || Boolean(leader.degraded);
  const tone = toOverviewTone(leader?.change_pct, degraded);

  return {
    id: "sector-leadership",
    label: "Sector leader",
    value: leader?.sector || (degraded ? "Updating" : "Unavailable"),
    delta:
      typeof leader?.change_pct === "number" && Number.isFinite(leader.change_pct)
        ? `${leader.change_pct >= 0 ? "+" : ""}${leader.change_pct.toFixed(2)}%`
        : degraded
          ? "Rotation delayed"
          : "No clear leader",
    tone,
    icon: ChartColumnIncreasing,
  };
}

function toOverviewMetrics(payload: KaiHomeInsightsV2 | null): MarketOverviewMetric[] {
  return [
    toIndexOverviewMetric(
      findOverviewRow(payload, (row) => String(row.label || "").toLowerCase().includes("s&p")),
      "S&P 500"
    ),
    toIndexOverviewMetric(
      findOverviewRow(payload, (row) => String(row.label || "").toLowerCase().includes("nasdaq")),
      "NASDAQ 100"
    ),
    toBreadthMetric(payload),
    toSectorLeadershipMetric(payload),
  ];
}

function toThemeIcon(title: string): LucideIcon {
  const matched = THEME_ICON_MAP.find((row) => row.test.test(title));
  return matched?.icon || LineChart;
}

function isDummyTheme(
  theme: NonNullable<KaiHomeInsightsV2["themes"]>[number]
): boolean {
  const sourceTags = Array.isArray(theme.source_tags)
    ? theme.source_tags.map((tag) => String(tag || "").toLowerCase())
    : [];
  const hasFallbackTag = sourceTags.some((tag) =>
    tag.includes("fallback") || tag.includes("dummy")
  );
  const subtitle = String(theme.subtitle || "").trim().toLowerCase();
  const hasHeadline = Boolean(String(theme.headline || "").trim());
  return Boolean(theme.degraded) && (hasFallbackTag || (!hasHeadline && subtitle.includes("sector rotation")));
}

function toThemeItems(payload: KaiHomeInsightsV2 | null): ThemeFocusItem[] {
  const themes = payload?.themes || [];
  if (!Array.isArray(themes)) return [];
  return themes
    .filter((theme): theme is NonNullable<KaiHomeInsightsV2["themes"]>[number] => Boolean(theme))
    .filter((theme) => !isDummyTheme(theme))
    .map((theme, idx) => ({
      id: `${String(theme.title || "theme")}-${idx}`,
      title: String(theme.title || "Theme"),
      subtitle: String(theme.subtitle || "Sector focus"),
      icon: toThemeIcon(String(theme.title || "")),
    }))
    .slice(0, 3);
}

function marketStatusBadge(payload: KaiHomeInsightsV2 | null): {
  label: string;
  className: string;
} | null {
  const row = findOverviewRow(payload, (candidate) =>
    String(candidate.label || "").toLowerCase().includes("market status")
  );
  if (!row) return null;
  const value = formatOverviewValue(row.value, {
    label: String(row.label || "Market Status"),
    degraded: Boolean(row.degraded),
  });
  if (!value) return null;

  if (Boolean(row.degraded)) {
    return {
      label: value,
      className:
        "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  if (value.toLowerCase().includes("open")) {
    return {
      label: value,
      className:
        "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  return {
    label: value,
    className: "border-border/70 bg-background/80 text-muted-foreground",
  };
}

type KaiMarketLoadOptions = {
  forceTokenRefresh?: boolean;
  manual?: boolean;
  staleOnly?: boolean;
};

function useKaiMarketHomeController() {
  const { user } = useAuth();
  const {
    vaultKey,
    tokenExpiresAt,
    unlockVault,
    getVaultOwnerToken,
    vaultOwnerToken,
  } = useVault();

  const [activePickSource, setActivePickSource] = useState("default");
  const [pickSourceReady, setPickSourceReady] = useState(false);
  const [financialResourceEnabled, setFinancialResourceEnabled] = useState(false);
  const [trackedSymbolsSeed, setTrackedSymbolsSeed] = useState<string[]>([]);
  const serverSeededPickSourceUsersRef = useRef(new Set<string>());
  const backgroundRefreshKeyRef = useRef<string | null>(null);
  const {
    data: financialResource,
  } = useKaiFinancialResource({
    userId: user?.uid ?? "",
    vaultOwnerToken,
    vaultKey,
    enabled: Boolean(user?.uid && vaultKey && vaultOwnerToken && financialResourceEnabled),
    backgroundRefresh: false,
  });

  useEffect(() => {
    if (!user?.uid) {
      setActivePickSource("default");
      setPickSourceReady(false);
      setFinancialResourceEnabled(false);
      setTrackedSymbolsSeed([]);
      return;
    }
    serverSeededPickSourceUsersRef.current.delete(user.uid);
    setActivePickSource(getKaiActivePickSource(user.uid));
    setPickSourceReady(true);
    setFinancialResourceEnabled(false);
    const seededFinancial = normalizeTrackedSymbols(
      KaiFinancialResourceService.peek(user.uid)?.data?.holdings
    );
    setTrackedSymbolsSeed(
      seededFinancial.length > 0
        ? seededFinancial
        : normalizeTrackedSymbols(
            KaiMarketHomeResourceService.resolveTrackedSymbols(user.uid)
          )
    );
  }, [user?.uid]);

  const trackedSymbols = useMemo(() => {
    if (!user?.uid) {
      return [];
    }
    return trackedSymbolsSeed;
  }, [trackedSymbolsSeed, user?.uid]);

  useEffect(() => {
    if (!user?.uid || trackedSymbolsSeed.length > 0) {
      return;
    }

    const resourceHoldings = normalizeTrackedSymbols(financialResource?.holdings);
    if (resourceHoldings.length > 0) {
      setTrackedSymbolsSeed(resourceHoldings);
      return;
    }

    const cacheDerived = normalizeTrackedSymbols(
      KaiMarketHomeResourceService.resolveTrackedSymbols(user.uid)
    );
    if (cacheDerived.length > 0) {
      setTrackedSymbolsSeed(cacheDerived);
    }
  }, [financialResource?.holdings, trackedSymbolsSeed.length, user?.uid]);

  const resolveToken = useCallback(
    async (forceRefresh = false): Promise<string> => {
      if (!user?.uid) {
        throw new Error("Missing authenticated user");
      }
      return await ensureKaiVaultOwnerToken({
        userId: user.uid,
        currentToken: getVaultOwnerToken?.() ?? vaultOwnerToken,
        currentExpiresAt: tokenExpiresAt,
        forceRefresh,
        onIssued: (issuedToken, expiresAt) => {
          if (vaultKey && (issuedToken !== vaultOwnerToken || expiresAt !== tokenExpiresAt)) {
            unlockVault(vaultKey, issuedToken, expiresAt);
          }
        },
      });
    },
    [
      getVaultOwnerToken,
      tokenExpiresAt,
      unlockVault,
      user?.uid,
      vaultKey,
      vaultOwnerToken,
    ]
  );

  const personalizedCacheKey = useMemo(
    () =>
      user?.uid && pickSourceReady
        ? CACHE_KEYS.KAI_MARKET_HOME(user.uid, toSymbolsKey(trackedSymbols), 7, activePickSource)
        : "kai_market_home_guest",
    [activePickSource, pickSourceReady, trackedSymbols, user?.uid]
  );
  const marketResourceReady = Boolean(user?.uid && pickSourceReady);

  const baselineResource = useStaleResource<KaiHomeInsightsV2 | null>({
    cacheKey: user?.uid ? CACHE_KEYS.KAI_MARKET_HOME_BASELINE(user.uid, 7) : "kai_market_home_baseline_guest",
    enabled: Boolean(user?.uid),
    resourceLabel: "kai_market_home_baseline",
    load: async (options) => {
      if (!user?.uid) {
        return null;
      }
      return await KaiMarketHomeResourceService.getBaselineStaleFirst({
        userId: user.uid,
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
    load: async (options) => {
      if (!user?.uid) {
        return null;
      }
      const currentToken = getVaultOwnerToken?.() ?? vaultOwnerToken ?? null;
      if (options?.force) {
        if (!currentToken && !vaultKey) {
          return null;
        }
        const forcedToken =
          currentToken && !vaultKey ? currentToken : await resolveToken(true);
        return await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
          userId: user.uid,
          vaultOwnerToken: forcedToken,
          pickSource: activePickSource,
          symbols: trackedSymbols,
          daysBack: 7,
          forceRefresh: true,
          backgroundRefresh: false,
        });
      }

      const cachedOrDevice = await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
        userId: user.uid,
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
          userId: user.uid,
          vaultOwnerToken: currentToken,
          pickSource: activePickSource,
          symbols: trackedSymbols,
          daysBack: 7,
          forceRefresh: false,
          backgroundRefresh: true,
        });
      }

      if (!vaultKey) {
        return null;
      }
      const token = await resolveToken(false);
      return await KaiMarketHomeResourceService.getPersonalizedStaleFirst({
        userId: user.uid,
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
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      setFinancialResourceEnabled(false);
      backgroundRefreshKeyRef.current = null;
      return;
    }

    let cancelled = false;
    const hasCachedMarketPayload = Boolean(
      baselineResource.snapshot?.data ||
        baselineResource.data ||
        personalizedResource.snapshot?.data ||
        personalizedResource.data
    );

    const enable = () => {
      if (!cancelled) {
        setFinancialResourceEnabled(true);
      }
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions
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

    const timeoutId = globalThis.setTimeout(enable, hasCachedMarketPayload ? 1400 : 250);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutId);
    };
  }, [
    baselineResource.data,
    baselineResource.snapshot?.data,
    personalizedResource.data,
    personalizedResource.snapshot?.data,
    user?.uid,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!user?.uid || !vaultOwnerToken || !personalizedPayload) {
      return;
    }

    const refreshKey = [
      user.uid,
      activePickSource,
      toSymbolsKey(trackedSymbols),
    ].join(":");

    if (backgroundRefreshKeyRef.current === refreshKey) {
      return;
    }
    backgroundRefreshKeyRef.current = refreshKey;

    const timeoutId = globalThis.setTimeout(() => {
      void KaiMarketHomeResourceService.refreshPersonalized({
        userId: user.uid,
        vaultOwnerToken,
        pickSource: activePickSource,
        symbols: trackedSymbols,
        daysBack: 7,
      }).catch(() => undefined);
    }, 1800);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [activePickSource, personalizedPayload, trackedSymbols, user?.uid, vaultOwnerToken]);

  useEffect(() => {
    const nextSource = String(personalizedPayload?.active_pick_source || "").trim();
    const userId = user?.uid;
    if (!userId || !nextSource || serverSeededPickSourceUsersRef.current.has(userId)) return;
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
  }, [activePickSource, personalizedPayload?.active_pick_source, user?.uid]);

  useEffect(() => {
    setKaiActivePickSource(user?.uid, activePickSource);
  }, [activePickSource, user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void baselineResource.refresh();
        if (marketResourceReady) {
          void personalizedResource.refresh();
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [baselineResource, marketResourceReady, personalizedResource, user?.uid]);

  const loadInsights = useCallback(
    async ({
      forceTokenRefresh = false,
      manual = false,
    }: KaiMarketLoadOptions = {}) => {
      if (!user?.uid) {
        return;
      }
      const shouldForce = Boolean(forceTokenRefresh || manual);
      await baselineResource.refresh({ force: shouldForce });
      if (marketResourceReady && (vaultOwnerToken || vaultKey)) {
        await personalizedResource.refresh({ force: shouldForce });
      }
    },
    [baselineResource, marketResourceReady, personalizedResource, user?.uid, vaultKey, vaultOwnerToken]
  );

  const handlePickSourceChange = useCallback(
    (nextSource: string) => {
      if (!nextSource || nextSource === activePickSource) return;
      setActivePickSource(nextSource);
    },
    [activePickSource]
  );

  return {
    payload,
    loading: !payload && baselineResource.loading,
    refreshing: baselineResource.refreshing || personalizedResource.refreshing,
    error: payload
      ? personalizedResource.error || baselineResource.error
      : baselineResource.error || personalizedResource.error,
    activePickSource,
    loadInsights,
    handlePickSourceChange,
  };
}

export function KaiMarketPreviewView() {
  const {
    payload,
    loading,
    refreshing,
    error,
    activePickSource,
    loadInsights,
    handlePickSourceChange,
  } = useKaiMarketHomeController();
  const [retainedPayload, setRetainedPayload] = useState<KaiHomeInsightsV2 | null>(payload);

  useEffect(() => {
    if (payload) {
      setRetainedPayload(payload);
    }
  }, [payload]);

  const effectivePayload = payload ?? retainedPayload;
  const hasPayload = Boolean(effectivePayload);
  const overviewMetrics = useMemo(() => toOverviewMetrics(effectivePayload), [effectivePayload]);
  const marketStatus = useMemo(() => marketStatusBadge(effectivePayload), [effectivePayload]);
  const themeItems = useMemo(() => toThemeItems(effectivePayload), [effectivePayload]);
  const pickSources = useMemo<KaiHomePickSource[]>(
    () =>
      Array.isArray(effectivePayload?.pick_sources)
        ? effectivePayload.pick_sources.filter((source) => Boolean(source?.id))
        : [],
    [effectivePayload]
  );
  const pickRows = useMemo(
    () =>
      Array.isArray(effectivePayload?.pick_rows)
        ? effectivePayload.pick_rows.filter((row) => Boolean(row?.symbol))
        : Array.isArray(effectivePayload?.renaissance_list)
          ? effectivePayload.renaissance_list.filter((row) => Boolean(row?.symbol))
        : [],
    [effectivePayload]
  );
  const spotlightRows = useMemo(
    () =>
      Array.isArray(effectivePayload?.spotlights)
        ? effectivePayload.spotlights.filter((row) => Boolean(row?.symbol)).slice(0, 2)
        : [],
    [effectivePayload]
  );
  const scenarioSignal = useMemo(
    () => (Array.isArray(effectivePayload?.signals) ? effectivePayload.signals[0] : undefined),
    [effectivePayload]
  );
  const scenarioSignals = useMemo(
    () =>
      Array.isArray(effectivePayload?.signals)
        ? effectivePayload.signals.filter((signal) => Boolean(signal?.id)).slice(0, 3)
        : [],
    [effectivePayload]
  );
  const _scenarioSignalSupportingItems = useMemo(
    () => deriveSignalSupportingItems(scenarioSignal, pickRows),
    [pickRows, scenarioSignal]
  );
  const primarySignalEvidence = useMemo(
    () => signalEvidenceLines(scenarioSignal, effectivePayload, pickRows),
    [effectivePayload, pickRows, scenarioSignal]
  );
  const primarySignalGroups = useMemo(
    () => signalDetailGroups(scenarioSignal, effectivePayload, pickRows),
    [effectivePayload, pickRows, scenarioSignal]
  );
  const showConnectPortfolio = useMemo(() => {
    if (!hasPayload) return false;
    if (effectivePayload?.meta?.market_mode !== "personalized") return false;
    const count = Number(effectivePayload?.hero?.holdings_count ?? 0);
    return !Number.isFinite(count) || count <= 0;
  }, [effectivePayload, hasPayload]);

  return (
    <AppPageShell
      as="div"
      width="expanded"
      className="pb-8"
    >
      <AppPageContentRegion>
        <SurfaceStack>
      {loading && !hasPayload ? (
        <SurfaceCard tone="default" data-testid="page-primary-module">
          <SurfaceCardContent className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing the market surface from your last available cache.
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}

      {error ? (
        <SurfaceCard tone="critical">
          <SurfaceCardContent className="space-y-3 text-left">
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-4 w-4" />
              <p className="text-sm font-semibold">
                {hasPayload ? "Failed to refresh market home" : "Failed to load market home"}
              </p>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{error}</p>
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => void loadInsights({ manual: true })}
            >
              Retry
            </Button>
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}

      {hasPayload ? (
        <div className="flex flex-col gap-12">
          <section className="space-y-4">
            <SectionHeader
              eyebrow="Pulse"
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  Market overview
                  {marketStatus ? (
                    <Badge variant="outline" className={cn("text-[10px] font-medium", marketStatus.className)}>
                      {marketStatus.label}
                    </Badge>
                  ) : null}
                </span>
              }
              description="A denser read of the current tape with stronger status cues and less filler."
              icon={ChartColumnIncreasing}
              accent="default"
              actions={
                <Button
                  variant="none"
                  effect="fade"
                  disabled={refreshing}
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  onClick={() => void loadInsights({ manual: true })}
                >
                  {refreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              }
            />
            <MarketOverviewGrid metrics={overviewMetrics} />
          </section>

          <section className="space-y-4">
            <SectionHeader
              eyebrow="Advisor signals"
              title="RIA’s picks"
              description="Choose the default Kai list or any connected advisor source. Kai remembers the last active selection and uses it for market and stock comparison surfaces."
              icon={BriefcaseBusiness}
              accent="emerald"
            />
            <RiaPicksList
              rows={pickRows}
              sources={pickSources}
              activeSourceId={activePickSource}
              onSourceChange={handlePickSourceChange}
            />
          </section>

          <section className="space-y-4">
            <SectionHeader
              eyebrow="Market read"
              title="Signals worth noting"
              description="A tighter read of what the current tape is implying before you move into deeper analysis."
              icon={Activity}
              accent="default"
            />
            {scenarioSignal ? (
              <SurfaceCard accent="none">
                <SurfaceCardContent className="space-y-4 sm:space-y-5">
                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(260px,0.95fr)]">
                    <SurfaceInset className="space-y-3">
                      <div className="space-y-1.5">
                        <p className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                          {scenarioSignal.title}
                        </p>
                        <p className="text-sm leading-6 text-muted-foreground">
                          {scenarioSignal.summary}
                        </p>
                      </div>
                      {primarySignalEvidence.length ? (
                        <div className="grid gap-2">
                          {primarySignalEvidence.map((line) => (
                            <p key={line} className="text-sm leading-6 text-foreground/85">
                              {line}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm leading-6 text-muted-foreground">
                          Kai is summarizing the dominant tape posture from the active advisor lane.
                        </p>
                      )}
                    </SurfaceInset>

                    <SurfaceInset className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                            className={cn(
                              "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                              signalConfidenceTone(scenarioSignal)
                            )}
                        >
                          {signalConfidenceLabel(scenarioSignal)}
                        </span>
                        <span className="rounded-full border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Primary signal
                        </span>
                      </div>
                      {visibleSignalSourceTags(scenarioSignal).length ? (
                        <div className="flex flex-wrap gap-2">
                          {visibleSignalSourceTags(scenarioSignal).slice(0, 3).map((tag) => (
                            <Badge
                              key={tag}
                              variant="outline"
                              className="border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-[10px] font-medium text-muted-foreground"
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                        <div className="rounded-[calc(var(--app-card-radius-compact)-4px)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-3 py-2.5 shadow-[var(--shadow-xs)]">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            Read
                          </p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {signalHeadlineLabel(scenarioSignal)}
                          </p>
                        </div>
                        <div className="rounded-[calc(var(--app-card-radius-compact)-4px)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-3 py-2.5 shadow-[var(--shadow-xs)]">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            Scope
                          </p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {primarySignalGroups.length} focus blocks
                          </p>
                        </div>
                      </div>
                    </SurfaceInset>
                  </div>

                  {primarySignalGroups.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {primarySignalGroups.map((group) => (
                        <SignalGroupBlock
                          key={`${scenarioSignal.id}:${group.label}`}
                          scopeId={scenarioSignal.id}
                          label={group.label}
                          symbols={group.symbols}
                        />
                      ))}
                    </div>
                  ) : null}

                  {scenarioSignals.length > 1 ? (
                    <div className="grid gap-3 xl:grid-cols-2">
                      {scenarioSignals.slice(1).map((signal) => (
                        <SurfaceInset
                          key={signal.id}
                          className="space-y-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="space-y-1">
                              <p className={cn("text-[10px] font-semibold uppercase tracking-[0.16em]", signalAccentClass(signal))}>
                                {signalHeadlineLabel(signal)}
                              </p>
                              <p className="text-sm font-semibold tracking-tight text-foreground">
                              {signal.title}
                            </p>
                          </div>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                signalConfidenceTone(signal)
                              )}
                            >
                              {signalConfidenceLabel(signal)}
                            </span>
                          </div>
                          <p className="text-sm leading-5 text-muted-foreground">
                            {signal.summary}
                          </p>
                          {signalEvidenceLines(signal, effectivePayload, pickRows).length ? (
                            <div className="space-y-1.5">
                              {signalEvidenceLines(signal, effectivePayload, pickRows).map((line) => (
                                <p key={line} className="text-xs leading-5 text-foreground/85">
                                  {line}
                                </p>
                              ))}
                            </div>
                          ) : null}
                          {signalDetailGroups(signal, effectivePayload, pickRows).length ? (
                            <div className="space-y-1.5">
                              {signalDetailGroups(signal, effectivePayload, pickRows).map((group) => (
                                <SignalGroupBlock
                                  key={`${signal.id}:${group.label}`}
                                  scopeId={signal.id}
                                  label={group.label}
                                  symbols={group.symbols}
                                />
                              ))}
                            </div>
                          ) : null}
                        </SurfaceInset>
                      ))}
                    </div>
                  ) : null}
                </SurfaceCardContent>
              </SurfaceCard>
              ) : (
                <SurfaceCard tone="warning">
                  <SurfaceCardContent className="text-sm text-muted-foreground">
                  Scenario insight is unavailable at the moment.
                </SurfaceCardContent>
              </SurfaceCard>
            )}
          </section>

          {themeItems.length > 0 ? (
            <section className="space-y-4">
              <SectionHeader
                eyebrow="Narratives"
                title="Themes in focus"
                description="Compact narratives that can shape how the next debate or trade idea gets framed."
                icon={Cpu}
                accent="default"
              />
              <ThemeFocusList themes={themeItems} />
            </section>
          ) : null}

          <section className="space-y-4">
            <SectionHeader
              eyebrow="Explore the market with Kai"
              title="What matters now"
              description="News and spotlight names grouped together so the freshest market context stays in one place."
              icon={Target}
              accent="default"
            />
            <div className="space-y-4">
              {spotlightRows.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold tracking-tight text-foreground">
                      Highest-conviction names in the current tape
                    </h3>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {spotlightRows.length} live
                    </span>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {spotlightRows.map((row) => (
                      <SpotlightFeatureTile key={row.symbol} row={row} />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[120px] items-center justify-center rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5 text-sm text-muted-foreground shadow-[var(--app-card-shadow-standard)]">
                  Spotlight names are loading right now.
                </div>
              )}
              <MarketHeadlinesRail rows={effectivePayload?.news_tape || []} />
            </div>
          </section>

          {showConnectPortfolio ? (
            <section className="space-y-4">
              <SectionHeader
                eyebrow="Portfolio context"
                title="Bring your own positions"
                description="Connecting a portfolio makes the market page and downstream debate surfaces meaningfully more personal."
                icon={BriefcaseBusiness}
                accent="emerald"
              />
              <ConnectPortfolioCta />
            </section>
          ) : null}
        </div>
      ) : null}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
