"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ChartColumnIncreasing,
  Cpu,
  ExternalLink,
  LineChart,
  Loader2,
  Newspaper,
  Percent,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/app-ui/page-sections";
import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceInset,
  SurfaceStack,
  surfaceInteractiveShellClassName,
} from "@/components/app-ui/surfaces";
import { ConnectPortfolioCta } from "@/components/kai/cards/connect-portfolio-cta";
import {
  MarketOverviewGrid,
  type MarketOverviewDetailPanel,
  type MarketOverviewMetric,
} from "@/components/kai/cards/market-overview-grid";
import { RiaPicksList } from "@/components/kai/cards/renaissance-market-list";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { ThemeFocusList, type ThemeFocusItem } from "@/components/kai/cards/theme-focus-list";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
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
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

const MARKET_GLASS_CARD_CLASSNAME =
  "bg-[linear-gradient(180deg,rgba(255,255,255,0.88)_0%,rgba(248,250,252,0.72)_52%,rgba(241,245,249,0.58)_100%)] dark:bg-[color:var(--app-card-surface-default-solid)]";

const MARKET_SIGNAL_CARD_CLASSNAME = cn(
  MARKET_GLASS_CARD_CLASSNAME,
  "border-[color:color-mix(in_srgb,var(--app-card-border-strong)_74%,rgba(59,130,246,0.16)_26%)] shadow-[var(--app-card-shadow-standard)]"
);

const MARKET_SIGNAL_INSET_CLASSNAME =
  "border-[color:color-mix(in_srgb,var(--app-card-border-standard)_74%,rgba(148,163,184,0.18)_26%)] bg-white/80 text-foreground dark:bg-[var(--app-card-surface-compact)]";

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

type SignalGroupDetailPanel = {
  eyebrow: string;
  title: string;
  summary: string;
  sections: MarketOverviewDetailPanel["sections"];
};

function signalGroupSummary(scopeLabel: string, label: string, count: number): string {
  if (label.toLowerCase().includes("buy")) {
    return `${count} names are currently supporting the ${scopeLabel.toLowerCase()} read on the buy side.`;
  }
  if (label.toLowerCase().includes("sell") || label.toLowerCase().includes("reduce")) {
    return `${count} names are currently leaning defensive inside the ${scopeLabel.toLowerCase()} read.`;
  }
  return `${count} names are contributing to the ${scopeLabel.toLowerCase()} grouping right now.`;
}

function buildSignalGroupDetailPanel(params: {
  scopeLabel: string;
  label: string;
  symbols: string[];
  supportingLines?: string[];
}): SignalGroupDetailPanel {
  const topNames = params.symbols.slice(0, 12);
  const overflowCount = Math.max(0, params.symbols.length - topNames.length);
  return {
    eyebrow: "Signal detail",
    title: `${params.label} · ${params.symbols.length} names`,
    summary: signalGroupSummary(params.scopeLabel, params.label, params.symbols.length),
    sections: [
      {
        title: "Names in scope",
        lines: [
          topNames.join(", "),
          overflowCount > 0 ? `${overflowCount} more names are in this grouping.` : "This is the full current group.",
        ],
      },
      ...(params.supportingLines?.length
        ? [
            {
              title: "Why this matters",
              lines: params.supportingLines,
            },
          ]
        : []),
    ],
  };
}

function SignalGroupBlock({
  scopeLabel,
  label,
  symbols,
  onOpen,
}: {
  scopeLabel: string;
  label: string;
  symbols: string[];
  onOpen?: () => void;
}) {
  const top = symbols.slice(0, 5);
  const actionable = Boolean(onOpen);

  const content = (
    <div className="rounded-[var(--app-card-radius-compact)] border border-[color:color-mix(in_srgb,var(--app-card-border-strong)_72%,rgba(99,102,241,0.12)_28%)] bg-[linear-gradient(180deg,rgba(255,255,255,0.9)_0%,rgba(244,247,252,0.82)_100%)] px-4 py-3.5 transition-[background-color,border-color,box-shadow,transform] duration-200 group-hover:border-[color:color-mix(in_srgb,var(--app-card-border-strong)_82%,rgba(99,102,241,0.2)_18%)] group-hover:bg-white/95 group-hover:shadow-[var(--shadow-xs)] dark:bg-[var(--app-card-surface-compact)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {scopeLabel}
          </p>
          <p className="mt-1 text-sm font-semibold tracking-tight text-foreground">{label}</p>
        </div>
        {actionable ? (
          <span className="rounded-full border border-[color:var(--app-card-border-standard)] bg-white/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/72 shadow-[var(--shadow-xs)] dark:bg-background/50 dark:text-muted-foreground">
            View
          </span>
        ) : null}
      </div>
      <div className="mt-3 space-y-2">
        <p className="text-xl font-semibold tracking-tight text-foreground">{symbols.length} names</p>
        <p className="line-clamp-2 text-xs leading-5 text-foreground/72 dark:text-muted-foreground">
          {top.length > 0 ? `${top.join(", ")}${symbols.length > 5 ? "..." : ""}` : "Names are still loading."}
        </p>
      </div>
    </div>
  );

  if (!actionable) return content;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative isolate w-full rounded-[var(--app-card-radius-compact)] text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2"
    >
      {content}
      <MaterialRipple variant="none" effect="fade" className="z-10" />
    </button>
  );
}

function SignalBoardCard({
  eyebrow,
  title,
  summary,
  badge,
  children,
  className,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  summary?: string;
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <SurfaceCard
      accent="none"
      className={cn("h-full", MARKET_SIGNAL_CARD_CLASSNAME, className)}
    >
      <SurfaceCardContent className={cn("flex h-full flex-col gap-4 p-4 sm:p-5", compact && "gap-3 p-4")}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {eyebrow}
            </p>
            <p className={cn("text-base font-semibold tracking-tight text-foreground sm:text-lg", compact && "text-[15px] sm:text-base")}>
              {title}
            </p>
          </div>
          {badge ? <div className="shrink-0">{badge}</div> : null}
        </div>
        {summary ? (
          <p className={cn("text-sm leading-6 text-foreground/72 dark:text-muted-foreground", compact && "text-xs leading-5")}>{summary}</p>
        ) : null}
        {children ? <div className="mt-auto space-y-3">{children}</div> : null}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function MarketSectionLead({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
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
      <SurfaceCard className={cn("h-full", MARKET_GLASS_CARD_CLASSNAME)}>
        <SurfaceCardContent className="flex h-full min-h-[240px] items-center justify-center p-5 text-sm text-muted-foreground">
          No recent market headlines are available right now.
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard className={cn("h-full overflow-hidden", MARKET_GLASS_CARD_CLASSNAME)}>
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

function formatOverviewAsOf(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "Timestamp unavailable";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "Timestamp unavailable";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function buildIndexDetailPanel(
  row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null,
  label: string,
  value: string,
  delta: string,
  tone: MarketOverviewMetric["tone"]
): MarketOverviewDetailPanel {
  const sourceLabel = normalizeOverviewSource(row?.source) || "Live benchmark feed";
  const degraded = !row || Boolean(row.degraded);

  return {
    eyebrow: "Overview",
    title: label,
    summary: `${label} is one of the benchmark signals Kai uses to frame the current tape before you move into deeper analysis.`,
    value,
    delta,
    statusLabel: degraded ? "Delayed snapshot" : "Live benchmark read",
    statusTone: degraded ? "warning" : tone,
    sections: [
      {
        title: "Snapshot context",
        lines: [
          degraded
            ? "This tile is using delayed or incomplete benchmark context."
            : "This benchmark is part of the live market overview feed.",
          `Source: ${sourceLabel}`,
          `As of ${formatOverviewAsOf(row?.as_of)}`,
        ],
      },
      {
        title: "Why it matters",
        lines: [
          "Use this benchmark to anchor the broad tape before moving into advisor ideas or deeper name-level work.",
        ],
      },
    ],
  };
}

function toIndexOverviewMetric(
  row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null,
  fallbackLabel: string
): MarketOverviewMetric {
  const degraded = !row || Boolean(row.degraded);
  const label = String(row?.label || fallbackLabel);
  const tone = toOverviewTone(row?.delta_pct, degraded);
  const value = formatOverviewValue(row?.value, { label, degraded });
  const delta = formatOverviewDelta(row?.delta_pct, {
    label,
    source: row?.source,
    degraded,
  });
  return {
    id: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    value,
    delta,
    tone,
    icon: iconForOverview(label, tone),
    detailPanel: buildIndexDetailPanel(row, label, value, delta, tone),
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
    detailPanel: {
      eyebrow: "Overview",
      title: "Advancers vs decliners",
      summary: "Breadth shows whether participation is broad or concentrated across the names Kai is tracking right now.",
      value,
      delta:
        trackedCount > 0
          ? `${gainers} higher · ${losers} lower`
          : degraded
            ? "Breadth delayed"
            : "Awaiting breadth snapshot",
      statusLabel: degraded ? "Delayed breadth read" : "Breadth live",
      statusTone: tone,
      sections: [
        {
          title: "Participation",
          lines: [
            trackedCount > 0
              ? `${gainers} of ${trackedCount} tracked names are advancing.`
              : "Kai does not have a fresh breadth snapshot yet.",
            trackedCount > 0
              ? `${losers} tracked names are declining.`
              : "The breadth feed is still warming.",
          ],
        },
        {
          title: "Leaders",
          lines: [
            _topHigher.length ? `Higher today: ${_topHigher.join(", ")}` : "Higher-today leaders are still populating.",
            _topLower.length ? `Lower today: ${_topLower.join(", ")}` : "Lower-today names are still populating.",
          ],
        },
      ],
    },
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
  const sortedSectors = [...sectorRows]
    .sort((left, right) => Number(right.change_pct || 0) - Number(left.change_pct || 0))
    .slice(0, 3)
    .map((row) => {
      const changePct = Number(row.change_pct || 0);
      return `${row.sector}: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    });

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
    detailPanel: {
      eyebrow: "Overview",
      title: "Sector leader",
      summary: "Sector rotation highlights where leadership is concentrating in the current tape.",
      value: leader?.sector || (degraded ? "Updating" : "Unavailable"),
      delta:
        typeof leader?.change_pct === "number" && Number.isFinite(leader.change_pct)
          ? `${leader.change_pct >= 0 ? "+" : ""}${leader.change_pct.toFixed(2)}%`
          : degraded
            ? "Rotation delayed"
            : "No clear leader",
      statusLabel: degraded ? "Rotation delayed" : "Rotation live",
      statusTone: tone,
      sections: [
        {
          title: "Leader context",
          lines: [
            leader?.sector
              ? `${leader.sector} is leading the current sector board.`
              : "Kai has not resolved a clean sector leader yet.",
            typeof leader?.change_pct === "number" && Number.isFinite(leader.change_pct)
              ? `Move: ${leader.change_pct >= 0 ? "+" : ""}${leader.change_pct.toFixed(2)}%`
              : "Rotation percentage is not available yet.",
          ],
        },
        {
          title: "Top rotation board",
          lines: sortedSectors.length ? sortedSectors : ["Sector rankings are still populating."],
        },
      ],
    },
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

function formatCacheAgeLabel(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 10) return "Updated just now";
  if (safeSeconds < 60) return `Updated ${safeSeconds}s ago`;
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

function formatLocalTimestamp(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function marketCacheTimerMeta(payload: KaiHomeInsightsV2 | null): {
  initialAgeSeconds: number;
  cacheTier: string | null;
  warmSource: string | null;
  stale: boolean;
} | null {
  const meta = payload?.meta;
  if (!meta) return null;
  const cacheAgeSeconds = Number(meta.cache_age_seconds ?? payload?.cache_age_seconds ?? 0);
  const initialAgeSeconds = Number.isFinite(cacheAgeSeconds) ? Math.max(0, cacheAgeSeconds) : 0;
  return {
    initialAgeSeconds,
    cacheTier: typeof meta.cache_tier === "string" ? meta.cache_tier : null,
    warmSource: typeof meta.warm_source === "string" ? meta.warm_source : null,
    stale: Boolean(meta.stale ?? payload?.stale),
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
  const [selectedOverviewMetric, setSelectedOverviewMetric] = useState<MarketOverviewMetric | null>(
    null
  );
  const [selectedSignalGroup, setSelectedSignalGroup] = useState<SignalGroupDetailPanel | null>(null);
  const [cacheTimerSeconds, setCacheTimerSeconds] = useState(0);
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();

  useEffect(() => {
    if (payload) {
      setRetainedPayload(payload);
    }
  }, [payload]);

  const effectivePayload = payload ?? retainedPayload;
  const hasPayload = Boolean(effectivePayload);
  const cacheTimerMeta = useMemo(() => marketCacheTimerMeta(effectivePayload), [effectivePayload]);
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
  const marketVoiceSurfaceMetadata = useMemo(() => {
    const sections = [
      {
        id: "market_overview",
        title: "Market overview",
        purpose: "Summarizes the live market tape, breadth, and sector leadership.",
      },
      {
        id: "ria_picks",
        title: "RIA's picks",
        purpose: "Lets you review and switch the active advisor signal source.",
      },
      {
        id: "signals",
        title: "Signals worth noting",
        purpose: "Highlights the strongest current market read before deeper analysis.",
      },
      {
        id: "themes",
        title: "Themes in focus",
        purpose: "Shows compact narratives shaping the next debate or trade setup.",
      },
      {
        id: "what_matters_now",
        title: "What matters now",
        purpose: "Groups spotlight names and market news into one discovery surface.",
      },
      ...(showConnectPortfolio
        ? [
            {
              id: "portfolio_context",
              title: "Bring your own positions",
              purpose: "Explains how connecting a portfolio personalizes the market surface.",
            },
          ]
        : []),
    ];
    const actions = [
      {
        id: "kai.market.refresh",
        label: "Refresh market home",
        purpose: "Refreshes the current market overview, signals, and discovery modules.",
        voiceAliases: ["refresh market", "refresh market home"],
      },
      {
        id: "kai.market.switch_pick_source",
        label: "Switch advisor pick source",
        purpose: "Changes which advisor source powers the current picks surface.",
        voiceAliases: ["switch advisor source", "change pick source"],
      },
      ...(showConnectPortfolio
        ? [
            {
              id: "nav.portfolio",
              label: "Connect portfolio",
              purpose: "Opens portfolio setup so Kai can personalize this market surface.",
              voiceAliases: ["connect portfolio", "open portfolio"],
            },
          ]
        : []),
    ];
    const controls = [
      {
        id: "refresh_market_home",
        label: "Refresh",
        purpose: "Refreshes the current market home surface.",
        actionId: "kai.market.refresh",
        role: "button",
        voiceAliases: ["refresh market", "refresh"],
      },
      {
        id: "pick_source_selector",
        label: "Advisor pick source",
        purpose: "Switches the active advisor signal source for RIA picks.",
        actionId: "kai.market.switch_pick_source",
        role: "selector",
        voiceAliases: ["pick source", "advisor source"],
      },
      ...(showConnectPortfolio
        ? [
            {
              id: "connect_portfolio",
              label: "Connect portfolio",
              purpose: "Opens portfolio connection so this surface can use your positions.",
              actionId: "nav.portfolio",
              role: "button",
              voiceAliases: ["connect portfolio"],
            },
          ]
        : []),
    ];
    const visibleModules = sections.map((section) => section.title);
    const marketMode = String(effectivePayload?.meta?.market_mode || "baseline").trim() || "baseline";

    return {
      screenId: "kai_market",
      title: "Market",
      purpose:
        "This screen is the market overview workspace for live tape, advisor signals, and discovery.",
      primaryEntity: effectivePayload?.active_pick_source || null,
      sections,
      actions,
      controls,
      concepts: [
        {
          id: "market",
          label: "Market",
          explanation: "Market is the live overview workspace for current tape, signals, and discovery.",
          aliases: ["market", "market home", "kai home"],
        },
      ],
      activeSection:
        refreshing || loading
          ? "Market overview"
          : showConnectPortfolio
            ? "Bring your own positions"
            : "What matters now",
      visibleModules,
      focusedWidget:
        refreshing || loading
          ? "Market overview"
          : activePickSource !== "default"
            ? "RIA's picks"
            : "What matters now",
      availableActions: actions.map((action) => action.label),
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(loading ? ["market_initial_load"] : []),
        ...(refreshing ? ["market_refresh"] : []),
      ],
      screenMetadata: {
        market_mode: marketMode,
        market_status_label: marketStatus?.label || null,
        has_payload: hasPayload,
        has_error: Boolean(error),
        active_pick_source: activePickSource,
        pick_source_count: pickSources.length,
        pick_row_count: pickRows.length,
        spotlight_count: spotlightRows.length,
        signal_count: scenarioSignals.length,
        theme_count: themeItems.length,
        news_count: Array.isArray(effectivePayload?.news_tape) ? effectivePayload.news_tape.length : 0,
        connect_portfolio_visible: showConnectPortfolio,
        holdings_count: Number(effectivePayload?.hero?.holdings_count ?? 0) || 0,
      },
    };
  }, [
    activePickSource,
    activeVoiceControlId,
    effectivePayload,
    error,
    hasPayload,
    lastVoiceControlId,
    loading,
    marketStatus?.label,
    pickRows.length,
    pickSources.length,
    refreshing,
    scenarioSignals.length,
    showConnectPortfolio,
    spotlightRows.length,
    themeItems.length,
  ]);
  usePublishVoiceSurfaceMetadata(marketVoiceSurfaceMetadata);

  useEffect(() => {
    setCacheTimerSeconds(cacheTimerMeta?.initialAgeSeconds ?? 0);
    if (!cacheTimerMeta) return;
    const timer = window.setInterval(() => {
      setCacheTimerSeconds((current) => current + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [cacheTimerMeta]);

  const marketFreshnessLabel = useMemo(() => {
    if (!cacheTimerMeta) return null;
    const localTimestamp = formatLocalTimestamp(effectivePayload?.generated_at);
    return {
      localTimestamp,
      freshness: formatCacheAgeLabel(cacheTimerSeconds),
    };
  }, [cacheTimerMeta, cacheTimerSeconds, effectivePayload?.generated_at]);

  const marketRefreshLabel = useMemo(() => {
    const statusShort =
      marketStatus?.label.toLowerCase().includes("open") ? "On" : marketStatus ? "Off" : null;
    const timeShort = marketFreshnessLabel?.localTimestamp || marketFreshnessLabel?.freshness || null;
    return [statusShort, timeShort].filter(Boolean).join(" · ");
  }, [marketFreshnessLabel, marketStatus]);

  return (
    <AppPageShell
      as="div"
      width="expanded"
      className="relative isolate pb-8"
    >
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-20 bg-[linear-gradient(180deg,#f8fbff_0%,#eef4ff_36%,#f6f8fc_100%)] dark:bg-[linear-gradient(180deg,#050816_0%,#0a1324_38%,#0b1020_100%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[58vh] bg-[radial-gradient(72%_52%_at_0%_0%,rgba(56,189,248,0.12)_0%,transparent_58%),radial-gradient(68%_48%_at_100%_0%,rgba(99,102,241,0.14)_0%,transparent_52%),radial-gradient(48%_36%_at_50%_14%,rgba(255,255,255,0.62)_0%,transparent_78%)] dark:bg-[radial-gradient(72%_52%_at_0%_0%,rgba(56,189,248,0.16)_0%,transparent_58%),radial-gradient(68%_48%_at_100%_0%,rgba(99,102,241,0.18)_0%,transparent_52%),radial-gradient(48%_36%_at_50%_14%,rgba(148,163,184,0.08)_0%,transparent_78%)]"
      />
      <AppPageHeaderRegion className="pt-2 sm:pt-3">
        <PageHeader
          eyebrow="Kai"
          title="Market"
          icon={ChartColumnIncreasing}
          description={"Track the market, advisor ideas, and your portfolio context in one place."}
          accent="marketplace"
          actions={
            <Button
              variant="none"
              effect="fade"
              disabled={refreshing}
              size="sm"
              className="h-9 rounded-full px-3"
              onClick={() => void loadInsights({ manual: true })}
            >
              <span className="flex items-center gap-2">
                {refreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {marketRefreshLabel ? (
                  <span className="text-[11px] font-semibold tracking-tight text-foreground/85">
                    {marketRefreshLabel}
                  </span>
                ) : null}
              </span>
            </Button>
          }
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <div className="relative isolate">
        <SurfaceStack>
      {loading && !hasPayload ? (
        <SurfaceCard
          tone="default"
          data-testid="page-primary-module"
          className={MARKET_GLASS_CARD_CLASSNAME}
        >
          <SurfaceCardContent className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <p className="max-w-sm text-balance">Loading your market view.</p>
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}

      {error ? (
        <SurfaceCard tone="critical" className={MARKET_GLASS_CARD_CLASSNAME}>
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
            <MarketSectionLead
              title="Overview"
              description="Benchmarks, breadth, and leadership in one clean read."
            />
            <MarketOverviewGrid
              metrics={overviewMetrics}
              onMetricSelect={(metric) => setSelectedOverviewMetric(metric)}
            />
          </section>

          <section className="space-y-4">
            <MarketSectionLead
              title="Advisor ideas"
              description="Choose Kai or a connected advisor source. The active source carries forward into market and comparison surfaces."
            />
            <RiaPicksList
              rows={pickRows}
              sources={pickSources}
              activeSourceId={activePickSource}
              onSourceChange={handlePickSourceChange}
              controlMode="adaptive-surface"
            />
          </section>

          <section className="space-y-4">
            <MarketSectionLead
              title="Signals worth watching"
              description="Strongest tape reads before deeper analysis."
            />
            {scenarioSignal ? (
              <div className="space-y-4">
                <SignalBoardCard
                  eyebrow={signalHeadlineLabel(scenarioSignal)}
                  title={scenarioSignal.title}
                  summary={scenarioSignal.summary}
                  badge={
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                        signalConfidenceTone(scenarioSignal)
                      )}
                    >
                      {signalConfidenceLabel(scenarioSignal)}
                    </span>
                  }
                >
                  <div className="flex flex-wrap gap-2">
                    {visibleSignalSourceTags(scenarioSignal).slice(0, 3).map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className="border-[color:var(--app-card-border-standard)] bg-white/82 text-[10px] font-medium text-foreground/72 dark:bg-[var(--app-card-surface-compact)] dark:text-muted-foreground"
                      >
                        {tag}
                      </Badge>
                    ))}
                    {primarySignalGroups.length ? (
                      <Badge
                        variant="outline"
                        className="border-[color:var(--app-card-border-standard)] bg-white/82 text-[10px] font-medium text-foreground/72 dark:bg-[var(--app-card-surface-compact)] dark:text-muted-foreground"
                      >
                        {primarySignalGroups.length} focus block{primarySignalGroups.length === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                    {scenarioSignals.length > 1 ? (
                      <Badge
                        variant="outline"
                        className="border-[color:var(--app-card-border-standard)] bg-white/82 text-[10px] font-medium text-foreground/72 dark:bg-[var(--app-card-surface-compact)] dark:text-muted-foreground"
                      >
                        {scenarioSignals.length - 1} secondary read{scenarioSignals.length - 1 === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="grid gap-2">
                    {primarySignalEvidence.length ? (
                      primarySignalEvidence.map((line) => (
                        <p
                          key={line}
                          className={cn(
                            "rounded-[calc(var(--app-card-radius-compact)-4px)] border px-3 py-2.5 text-sm leading-6 text-foreground/88",
                            MARKET_SIGNAL_INSET_CLASSNAME
                          )}
                        >
                          {line}
                        </p>
                      ))
                    ) : (
                      <p className={cn(
                        "rounded-[calc(var(--app-card-radius-compact)-4px)] border px-3 py-2.5 text-sm leading-6 text-foreground/72 dark:text-muted-foreground",
                        MARKET_SIGNAL_INSET_CLASSNAME
                      )}>
                        Kai is summarizing the dominant tape posture from the active advisor lane.
                      </p>
                    )}
                  </div>
                </SignalBoardCard>

                {primarySignalGroups.length ? (
                  <div className="space-y-3">
                    <p className="text-sm font-semibold tracking-tight text-foreground">
                      Focus blocks
                    </p>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {primarySignalGroups.map((group) => (
                        <SignalGroupBlock
                          key={`${scenarioSignal.id}:${group.label}`}
                          scopeLabel={signalHeadlineLabel(scenarioSignal)}
                          label={group.label}
                          symbols={group.symbols}
                          onOpen={() =>
                            setSelectedSignalGroup(
                              buildSignalGroupDetailPanel({
                                scopeLabel: signalHeadlineLabel(scenarioSignal),
                                label: group.label,
                                symbols: group.symbols,
                                supportingLines: primarySignalEvidence,
                              })
                            )
                          }
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                {scenarioSignals.length > 1 ? (
                  <div className="space-y-3">
                    <p className="text-sm font-semibold tracking-tight text-foreground">
                      Secondary reads
                    </p>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {scenarioSignals.slice(1).map((signal) => {
                        const evidence = signalEvidenceLines(signal, effectivePayload, pickRows);
                        const groups = signalDetailGroups(signal, effectivePayload, pickRows);

                        return (
                          <SignalBoardCard
                            key={signal.id}
                            eyebrow={signalHeadlineLabel(signal)}
                            title={signal.title}
                            summary={signal.summary}
                            compact
                            badge={
                              <span
                                className={cn(
                                  "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                                  signalConfidenceTone(signal)
                                )}
                              >
                                {signalConfidenceLabel(signal)}
                              </span>
                            }
                          >
                            {evidence.length ? (
                              <div className="grid gap-2">
                                {evidence.map((line) => (
                                  <p
                                    key={line}
                                    className={cn(
                                      "rounded-[calc(var(--app-card-radius-compact)-4px)] border px-3 py-2.5 text-xs leading-5 text-foreground/88",
                                      MARKET_SIGNAL_INSET_CLASSNAME
                                    )}
                                  >
                                    {line}
                                  </p>
                                ))}
                              </div>
                            ) : null}
                            {groups.length ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                {groups.map((group) => (
                                  <SignalGroupBlock
                                    key={`${signal.id}:${group.label}`}
                                    scopeLabel={signalHeadlineLabel(signal)}
                                    label={group.label}
                                    symbols={group.symbols}
                                    onOpen={() =>
                                      setSelectedSignalGroup(
                                        buildSignalGroupDetailPanel({
                                          scopeLabel: signalHeadlineLabel(signal),
                                          label: group.label,
                                          symbols: group.symbols,
                                          supportingLines: evidence,
                                        })
                                      )
                                    }
                                  />
                                ))}
                              </div>
                            ) : null}
                          </SignalBoardCard>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
                <SurfaceCard tone="warning" className={MARKET_GLASS_CARD_CLASSNAME}>
                  <SurfaceCardContent className="text-sm text-muted-foreground">
                  Scenario insight is unavailable at the moment.
                </SurfaceCardContent>
              </SurfaceCard>
            )}
          </section>

          {themeItems.length > 0 ? (
            <section className="space-y-4">
              <MarketSectionLead
                title="Themes in focus"
                description="Compact narratives that can shape how the next debate or trade idea gets framed."
              />
              <ThemeFocusList themes={themeItems} />
            </section>
          ) : null}

          <section className="space-y-4">
            <MarketSectionLead
              title="What matters now"
              description="News and spotlight names stay together so the freshest market context is easy to scan."
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
              <MarketSectionLead
                title="Bring your own positions"
                description="Connecting a portfolio makes the market page and downstream debate surfaces more personal."
              />
              <ConnectPortfolioCta />
            </section>
          ) : null}
        </div>
      ) : null}
        </SurfaceStack>
        </div>
      </AppPageContentRegion>

      <KaiControlSurface
        open={Boolean(selectedOverviewMetric?.detailPanel)}
        onOpenChange={(open) => {
          if (!open) setSelectedOverviewMetric(null);
        }}
        eyebrow={selectedOverviewMetric?.detailPanel?.eyebrow}
        title={selectedOverviewMetric?.detailPanel?.title || "Overview detail"}
        description={selectedOverviewMetric?.detailPanel?.summary}
      >
        {selectedOverviewMetric?.detailPanel ? (
          <div className="space-y-4">
            <SurfaceInset className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-2xl font-semibold tracking-tight text-foreground">
                    {selectedOverviewMetric.detailPanel.value || selectedOverviewMetric.value}
                  </p>
                  <p
                    className={cn(
                      "text-sm font-medium",
                      selectedOverviewMetric.detailPanel.statusTone === "positive" &&
                        "text-emerald-600 dark:text-emerald-400",
                      selectedOverviewMetric.detailPanel.statusTone === "negative" &&
                        "text-rose-600 dark:text-rose-400",
                      selectedOverviewMetric.detailPanel.statusTone === "warning" &&
                        "text-amber-700 dark:text-amber-300",
                      (!selectedOverviewMetric.detailPanel.statusTone ||
                        selectedOverviewMetric.detailPanel.statusTone === "neutral") &&
                        "text-muted-foreground"
                    )}
                  >
                    {selectedOverviewMetric.detailPanel.delta || selectedOverviewMetric.delta}
                  </p>
                </div>
                {selectedOverviewMetric.detailPanel.statusLabel ? (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] font-semibold uppercase tracking-[0.16em]",
                      selectedOverviewMetric.detailPanel.statusTone === "positive" &&
                        "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      selectedOverviewMetric.detailPanel.statusTone === "negative" &&
                        "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
                      selectedOverviewMetric.detailPanel.statusTone === "warning" &&
                        "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                      (!selectedOverviewMetric.detailPanel.statusTone ||
                        selectedOverviewMetric.detailPanel.statusTone === "neutral") &&
                        "border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-muted-foreground"
                    )}
                  >
                    {selectedOverviewMetric.detailPanel.statusLabel}
                  </Badge>
                ) : null}
              </div>
            </SurfaceInset>

            {selectedOverviewMetric.detailPanel.sections?.map((section) => (
              <SurfaceInset key={section.title} className="space-y-2 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {section.title}
                </p>
                <div className="space-y-2">
                  {section.lines.map((line) => (
                    <p key={line} className="text-sm leading-6 text-foreground/90">
                      {line}
                    </p>
                  ))}
                </div>
              </SurfaceInset>
            ))}
          </div>
        ) : null}
      </KaiControlSurface>

      <KaiControlSurface
        open={Boolean(selectedSignalGroup)}
        onOpenChange={(open) => {
          if (!open) setSelectedSignalGroup(null);
        }}
        eyebrow={selectedSignalGroup?.eyebrow}
        title={selectedSignalGroup?.title || "Signal detail"}
        description={selectedSignalGroup?.summary}
      >
        {selectedSignalGroup ? (
          <div className="space-y-4">
            {selectedSignalGroup.sections?.map((section) => (
              <SurfaceInset key={section.title} className="space-y-2 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {section.title}
                </p>
                <div className="space-y-2">
                  {section.lines.map((line) => (
                    <p key={line} className="text-sm leading-6 text-foreground/90">
                      {line}
                    </p>
                  ))}
                </div>
              </SurfaceInset>
            ))}
          </div>
        ) : null}
      </KaiControlSurface>
    </AppPageShell>
  );
}
