"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ChartColumnIncreasing,
  Cpu,
  LineChart,
  Loader2,
  Percent,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
  Zap,
} from "@/components/icons";
import { IndexSparkline, MarketIndexDetailSurface } from "@/components/kai/cards/market-index-detail";
import { AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { SectionHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import marketBriefingStyles from "@/components/kai/shared/market-briefing.module.css";
import { KaiWorkspaceHeader } from "@/components/kai/kai-workspace-header";
import { ConnectPortfolioCta } from "@/components/kai/cards/connect-portfolio-cta";
import { SectorRotationChart, getMarketSectorPeriodVoiceInventory } from "@/components/kai/cards/sector-rotation-chart";
export { SectorRotationChart, getMarketSectorPeriodVoiceInventory, sectorRowsForPeriod } from "@/components/kai/cards/sector-rotation-chart";
import { OneMarketNewsBriefing } from "@/components/kai/cards/market-news-briefing";
export { OneMarketNewsBriefing, OneMarketNewsCover, marketNewsImageUrl, shouldShowNewsCompanyLogo } from "@/components/kai/cards/market-news-briefing";
import {
  SymbolAvatar,
} from "@/components/kai/shared/symbol-avatar";
import { PermissionGate } from "@/components/privacy/permission-gate/permission-gate";
import {
  type MarketOverviewDetailPanel,
  type MarketOverviewMetric,
} from "@/components/kai/cards/market-overview-grid";
import {
  marketSurfaceVariablesClassName,
} from "@/components/kai/shared/market-surface-theme";
import {
  getLocalMarketPreviewPayload,
  isLocalMarketPreviewRequest,
} from "@/components/kai/shared/local-market-preview";
import type { ThemeFocusItem } from "@/components/kai/cards/theme-focus-list";
import { Button } from "@/lib/morphy-ux/button";
import {
  type KaiHomeInsightsV2,
  type KaiHomeRenaissanceItem,
  type KaiHomeWatchlistItem,
} from "@/lib/services/api-service";
import { diversifyMarketNewsRows } from "@/lib/kai/market-news-diversity";
import {
  openExternalUrl,
  requestInternalAppNavigation,
} from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";
import { normalizeMarketSymbol, useKaiMarketHome } from "@/components/kai/shared/kai-market-home-context";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { buildKaiMarketRoute, ROUTES } from "@/lib/navigation/routes";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/kai/actions/voice-surface-metadata";

function useRetainedSurfaceSelection<T>(
  selection: T | null,
  delayMs = 180,
): T | null {
  const [retained, setRetained] = useState<T | null>(selection);

  useEffect(() => {
    if (selection) {
      setRetained(selection);
      return;
    }

    const timeout = window.setTimeout(() => {
      setRetained(null);
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [delayMs, selection]);

  return retained;
}

const THEME_ICON_MAP: Array<{ test: RegExp; icon: LucideIcon }> = [
  { test: /ai|chip|semi|data|cloud|infra/i, icon: Cpu },
  { test: /rate|yield|inflation|macro/i, icon: Percent },
  { test: /energy|oil|gas|renewable|power/i, icon: Zap },
];

function formatMarketQuoteTime(value: string | null | undefined): string {
  return formatLocalDateTime(value, { hour: "numeric", minute: "2-digit" }) ?? "Time unavailable";
}

const oneMarketRootClassName = cn(
  marketSurfaceVariablesClassName,
  "relative isolate mx-auto flex min-h-0 w-full !max-w-none flex-col overflow-x-hidden !px-0 pb-0",
  "bg-transparent font-sans text-[color:var(--one-fg)] antialiased",
  // The page background always matches the app shell (--background) so the
  // route never paints its own lighter panel inside the shell (the "double
  // layout" partition). Cards/surfaces/text route through the same
  // --app-card-*/--foundation-* tokens Profile, Consent, and Feed use, so
  // Kai's edges/shadows/text match those refined surfaces instead of a
  // route-local palette.
  "[--one-bg:var(--background)] [--one-card:var(--app-card-surface-default-solid)] [--one-surface:var(--app-card-surface-compact)]",
  "[--one-hairline:var(--foundation-hairline)] [--one-line:var(--foundation-hairline)]",
  "[--one-fg:var(--foreground)] [--one-fg2:var(--muted-foreground)] [--one-fg3:color-mix(in_oklab,var(--muted-foreground)_82%,transparent)]",
  "[--one-blue:var(--app-accent)] [--one-link:var(--app-accent-deep)]",
  "dark:[--one-blue:var(--app-accent)] dark:[--one-link:var(--app-accent-deep)]",
  "[--one-up:var(--app-success-deep)] dark:[--one-up:var(--app-success-bright)]",
  "[--one-down:var(--app-destructive-deep)] dark:[--one-down:var(--app-destructive-bright)]",
  "[--one-news-neutral:#dfe1e6] [--one-news-neutral-ink:#565a63]",
  "dark:[--one-news-neutral:#8e8e93] dark:[--one-news-neutral-ink:#ffffff]",
  "[--one-indigo:#5856d6] [--one-indigo-t:rgba(88,86,214,0.12)]",
  "[--one-orange:#ff9500] [--one-orange-t:rgba(255,149,0,0.14)]",
  "[--one-teal:#30b0c7] [--one-teal-t:rgba(48,176,199,0.13)]",
  "[--one-glass-fill:linear-gradient(135deg,rgba(255,255,255,0.45),rgba(255,255,255,0.16))]",
  "dark:[--one-glass-fill:linear-gradient(135deg,rgba(44,44,46,0.86),rgba(28,28,30,0.62))]",
  "[--one-glass-float:0_16px_38px_-20px_rgba(0,0,0,0.28),0_4px_12px_-8px_rgba(0,0,0,0.10)]",
  "[--one-gutter:0px]",
);

type OneMarketDisplayRow = {
  symbol: string;
  companyName: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  sparkline?: number[] | null;
  degraded?: boolean;
  asOf?: string | null;
};

type OneMarketMoverTab = "gain" | "lose" | "active";

function formatOneMarketPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function toOneMarketRows(
  rows:
    | Array<
        | KaiHomeWatchlistItem
        | KaiHomeRenaissanceItem
        | NonNullable<KaiHomeInsightsV2["movers"]>["gainers"][number]
      >
    | null
    | undefined,
): OneMarketDisplayRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const sparklineSource = (
        row as { sparkline?: unknown } | null | undefined
      )?.sparkline;
      const sparkline =
        Array.isArray(sparklineSource) && sparklineSource.length > 1
          ? sparklineSource.filter(
              (point): point is number =>
                typeof point === "number" && Number.isFinite(point),
            )
          : null;
      return {
        symbol: normalizeMarketSymbol(row?.symbol),
        companyName: String(
          row?.company_name || row?.symbol || "Market name",
        ).trim(),
        price:
          typeof row?.price === "number" && Number.isFinite(row.price)
            ? row.price
            : null,
        changePct:
          typeof row?.change_pct === "number" && Number.isFinite(row.change_pct)
            ? row.change_pct
            : null,
        volume:
          typeof row?.volume === "number" && Number.isFinite(row.volume)
            ? row.volume
            : null,
        sparkline: sparkline && sparkline.length > 1 ? sparkline : null,
        degraded: Boolean(row?.degraded),
        asOf: row?.as_of ?? null,
      };
    })
    .filter((row) => Boolean(row.symbol));
}

function dedupeOneMarketRows(
  rows: OneMarketDisplayRow[],
): OneMarketDisplayRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDirectionalMover(
  row: OneMarketDisplayRow,
  direction: "gain" | "lose",
): boolean {
  if (typeof row.changePct !== "number" || !Number.isFinite(row.changePct))
    return false;
  return direction === "gain" ? row.changePct > 0 : row.changePct < 0;
}

export function toMoverGroups(
  payload: KaiHomeInsightsV2 | null,
): Record<OneMarketMoverTab, OneMarketDisplayRow[]> {
  // Provider buckets are advisory. The displayed direction must always agree
  // with the quote itself so a negative move can never appear in Gainers.
  const gainers = dedupeOneMarketRows(
    toOneMarketRows(payload?.movers?.gainers).filter((row) =>
      isDirectionalMover(row, "gain"),
    ),
  )
    .sort((left, right) => Number(right.changePct) - Number(left.changePct))
    .slice(0, 4);
  const losers = dedupeOneMarketRows(
    toOneMarketRows(payload?.movers?.losers).filter((row) =>
      isDirectionalMover(row, "lose"),
    ),
  )
    .sort((left, right) => Number(left.changePct) - Number(right.changePct))
    .slice(0, 4);
  const active = dedupeOneMarketRows(toOneMarketRows(payload?.movers?.active))
    .sort((left, right) => Number(right.volume || 0) - Number(left.volume || 0))
    .slice(0, 4);
  const groupDegraded = Boolean(payload?.movers?.degraded);
  const withGroupStatus = (rows: OneMarketDisplayRow[]) => rows.map((row) => ({
    ...row, degraded: Boolean(row.degraded || groupDegraded),
  }));
  return { gain: withGroupStatus(gainers), lose: withGroupStatus(losers), active: withGroupStatus(active) };
}

export function toIndexStripItems(
  payload: KaiHomeInsightsV2 | null,
): MarketOverviewMetric[] {
  const overviewRows = Array.isArray(payload?.market_overview)
    ? payload.market_overview.filter(
        (row) =>
          Boolean(row?.label) &&
          !String(row.label).toLowerCase().includes("market status"),
      )
    : [];

  return [
    {
      label: "S&P 500",
      symbol: "^GSPC",
      match: (label: string) =>
        label.includes("s&p") || label.includes("sp 500"),
    },
    { label: "NASDAQ Composite", symbol: "^IXIC", match: (label: string) => label.includes("nasdaq") },
    { label: "Dow Jones", symbol: "^DJI", match: (label: string) => label.includes("dow") },
    {
      label: "Russell 2000",
      symbol: "^RUT",
      match: (label: string) => label.includes("russell"),
    },
  ].map(({ label, symbol, match }) => {
    const row =
      overviewRows.find((candidate) =>
        (!candidate.symbol || candidate.symbol === symbol) &&
        match(String(candidate.label || "").toLowerCase()),
      ) || null;
    return row && typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0
      ? toIndexOverviewMetric({ ...row, label, degraded: Boolean(row.degraded || payload?.stale) }, label)
      : toIndexOverviewMetric(null, label);
  });
}

function openOneMarketHref(href: string) {
  if (/^https?:\/\//i.test(href)) {
    openExternalUrl(href);
    return;
  }
  requestInternalAppNavigation({ href, scroll: false });
}

function OneMarketSectionHeader({
  title,
  actionLabel,
  actionHref,
  actions,
}: {
  title: string;
  actionLabel?: string;
  actionHref?: string;
  actions?: ReactNode;
}) {
  return (
    <SectionHeader
      title={title}
      accent="neutral"
      className={cn(marketBriefingStyles.sectionHeader, "[&_[data-slot=section-header-row]]:flex-row [&_[data-slot=section-header-row]]:items-center [&_[data-slot=section-header-actions]]:w-auto")}
      actions={actions ?? (actionLabel && actionHref ? (
        <button type="button" onClick={() => openOneMarketHref(actionHref)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {actionLabel}<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : undefined)}
    />
  );
}

/**
 * Honest, data-driven sparkline built on recharts. Renders the REAL series;
 * when no series exists it renders a flat dashed baseline instead of
 * inventing a chart shape. Stroke color follows the actual tone, never a
 * hardcoded "always up" green.
 */
export function OneMarketIndexStrip({
  metrics,
  onMetricSelect,
}: {
  metrics: MarketOverviewMetric[];
  onMetricSelect: (metric: MarketOverviewMetric) => void;
}) {
  if (!metrics.length) return null;
  const firstStatus = metrics[0]?.quoteStatus;
  const sharedStatus = firstStatus && metrics.every((metric) => metric.quoteStatus === firstStatus)
    ? firstStatus : null;
  return (
    <div className={marketBriefingStyles.typography}>
    <p className="mb-2 text-xs leading-[18px] text-muted-foreground">Index levels in points</p>
    <div className="grid w-full divide-y divide-border/50 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
      {metrics.map((metric) => (
        <button key={metric.id || metric.label} type="button"
          onClick={() => onMetricSelect(metric)}
          aria-label={`${[`${metric.label}: ${metric.value}`, metric.delta, metric.quoteStatus].filter(Boolean).join(", ")}. Open details`}
          className="grid min-h-[76px] min-w-0 grid-cols-[minmax(0,1fr)_40px_minmax(6rem,auto)] items-center gap-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:flex sm:flex-col sm:items-stretch sm:gap-0 sm:px-4 sm:first:pl-0 sm:last:pr-0">
          <span className="min-w-0">
            <span className={cn("block text-foreground", marketBriefingStyles.indexLabel)}>{metric.label}</span>
            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
              {!sharedStatus && metric.quoteStatus ? <span>{metric.quoteStatus}{metric.quotedAt ? " · " : ""}</span> : null}
              {metric.quotedAt ? <time dateTime={metric.quotedAt} title={formatOverviewAsOf(metric.quotedAt)}>
                {formatMarketQuoteTime(metric.quotedAt)}
              </time> : sharedStatus ? "Time unavailable" : null}
            </span>
          </span>
          <span className="sm:order-last sm:mt-2"><IndexSparkline tone={metric.tone} series={metric.sparkline} /></span>
          <span className="flex min-w-0 flex-col gap-1 text-right sm:mt-3 sm:text-left">
            <span className={cn("block text-foreground", marketBriefingStyles.indexValue)}>{metric.value}</span>
            <span className={cn("text-xs font-medium tabular-nums",
              metric.tone === "positive" ? "text-[color:var(--one-up)]" : metric.tone === "negative" ? "text-[color:var(--one-down)]" : "text-muted-foreground")}>{metric.delta}</span>
          </span>
        </button>
      ))}
    </div>
    {sharedStatus ? <p className="border-t border-border/50 pt-3 text-xs leading-5 text-muted-foreground">{sharedStatus}</p> : null}
    </div>
  );
}

export function OneMarketMovers({ groups }: { groups: Record<OneMarketMoverTab, OneMarketDisplayRow[]> }) {
  const id = useId();
  const columns = [
    { key: "gain", title: "Movers", rows: groups.gain.slice(0, 3) },
    { key: "lose", title: "Losers", rows: groups.lose.slice(0, 3) },
  ] as const;
  const shown = columns.flatMap((column) => column.rows);
  const commonAsOf = shown[0]?.asOf ?? null;
  const sharedTime = shown.length > 0 && shown.every((row) => row.asOf === commonAsOf);
  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        {columns.map(({ key, title }) => <h3 key={key} id={`${id}-${key}`} className={marketBriefingStyles.groupLabel}>{title}</h3>)}
      </div>
      <div className="divide-y divide-border/50">
        {Array.from({ length: 3 }, (_, rank) => (
          <div key={rank} className="grid grid-cols-2 items-stretch gap-4" data-market-mover-pair>
            {columns.map(({ key, title, rows }) => {
              const row = rows[rank];
              if (!row) return <p key={key} data-market-mover-empty
                aria-label={`${title} ${rank + 1}: Quote unavailable`}
                className="flex min-h-12 items-center py-3 text-sm text-muted-foreground">Quote unavailable</p>;
              return <button key={`${key}:${row.symbol}`} type="button" aria-describedby={`${id}-${key}`}
                onClick={() => openOneMarketHref(buildKaiMarketRoute("analysis", { ticker: row.symbol }))}
                className="flex min-h-12 min-w-0 w-full flex-col items-stretch gap-1 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-1 gap-y-1">
                  <span className="min-w-0 break-words text-sm font-semibold text-foreground">{row.symbol}</span>
                  <span className={cn("shrink-0 text-right text-sm font-semibold tabular-nums", key === "gain" ? "text-[color:var(--one-up)]" : "text-[color:var(--one-down)]")}>{formatOneMarketPercent(row.changePct)}</span>
                </span>
                <span className="min-w-0 break-words text-xs leading-[18px] text-muted-foreground">
                  <SymbolAvatar symbol={row.symbol} name={row.companyName} size="md" className="float-left mr-1 mt-px h-4 w-4 rounded-full [&_img]:h-4 [&_img]:w-4" />
                  {row.companyName}
                </span>
                {!sharedTime ? <time dateTime={row.asOf || undefined} className="block text-xs text-muted-foreground" title={formatOverviewAsOf(row.asOf)}>{formatMarketQuoteTime(row.asOf)}</time> : null}
              </button>;
            })}
          </div>
        ))}
      </div>
      {sharedTime ? <p className="mt-1 border-t border-border/50 pt-3 text-xs leading-[18px] text-muted-foreground" data-market-mover-freshness>
        <time dateTime={commonAsOf || undefined}>{commonAsOf ? formatOverviewAsOf(commonAsOf) : "Quote time unavailable"}</time>
      </p> : null}
    </div>
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

function normalizeOverviewSource(
  source: string | null | undefined,
): string | null {
  if (!source) return null;
  const text = source.trim();
  if (!text || isUnavailableText(text)) return null;
  return text;
}

function formatOverviewAsOf(value: string | null | undefined): string {
  return formatLocalDateTime(value) ?? "Timestamp unavailable";
}

function formatOverviewValue(
  value: string | number | null | undefined,
  {
    label,
    degraded,
  }: {
    label: string;
    degraded: boolean;
  },
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) >= 1000) {
      return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    }
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
      value,
    );
  }
  if (typeof value === "string" && value.trim() && !isUnavailableText(value))
    return value;
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes("market status")) {
    return degraded ? "Status delayed" : "Updating status";
  }
  if (lowerLabel.includes("volatility") || lowerLabel.includes("vix")) {
    return degraded ? "Volatility delayed" : "Updating volatility";
  }
  // The strip renders a "Delayed" chip next to the label for degraded rows,
  // so the value slot stays factual instead of repeating "Data delayed".
  return degraded ? "Awaiting data" : "Updating";
}

function formatOverviewDelta(
  deltaPct: number | null | undefined,
  {
    label,
    degraded,
  }: {
    label: string;
    degraded: boolean;
  },
): string {
  if (typeof deltaPct !== "number" || !Number.isFinite(deltaPct)) {
    const lowerLabel = label.toLowerCase();
    if (lowerLabel.includes("market status")) {
      return degraded ? "Schedule fallback" : "Live session";
    }
    return "Change unavailable";
  }
  const sign = deltaPct >= 0 ? "+" : "";
  return `${sign}${deltaPct.toFixed(2)}%`;
}

function toOverviewTone(
  deltaPct: number | null | undefined,
  degraded: boolean,
): MarketOverviewMetric["tone"] {
  if (typeof deltaPct !== "number" || !Number.isFinite(deltaPct)) {
    return degraded ? "warning" : "neutral";
  }
  if (deltaPct > 0) return "positive";
  if (deltaPct < 0) return "negative";
  return "neutral";
}

function iconForOverview(
  label: string,
  tone: MarketOverviewMetric["tone"],
): LucideIcon {
  const lower = label.toLowerCase();
  if (lower.includes("volatility") || lower.includes("vix")) return Activity;
  if (lower.includes("yield") || lower.includes("rate"))
    return ChartColumnIncreasing;
  if (tone === "positive") return TrendingUp;
  if (tone === "negative") return TrendingDown;
  return LineChart;
}

function buildIndexDetailPanel(
  row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null,
  label: string,
  value: string,
  delta: string,
  tone: MarketOverviewMetric["tone"],
): MarketOverviewDetailPanel {
  const sourceLabel = normalizeOverviewSource(row?.source) || "Unavailable";
  const degraded = !row || Boolean(row.degraded);
  const quoteStatus = indexQuoteStatus(row);

  return {
    eyebrow: "Overview",
    title: label,
    summary: "US equity index · points",
    value,
    delta,
    statusLabel: quoteStatus,
    statusTone: degraded ? "warning" : tone,
    facts: [
      { label: "Source", value: sourceLabel },
      { label: "Quoted", value: formatOverviewAsOf(row?.as_of) },
    ],
    sections: [
      {
        title: "About this quote",
        lines: [
          "Index levels and daily changes reflect the provider quote time above.",
        ],
      },
      {
        title: "Why it matters",
        lines: [
          "Use this benchmark to understand broad market conditions before reviewing advisor ideas or individual investments.",
        ],
      },
    ],
  };
}

function indexQuoteStatus(
  row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null,
): string {
  if (!row || typeof row.value !== "number" || !Number.isFinite(row.value) || row.value <= 0)
    return "Unavailable";
  const quotedAt = row.as_of ? Date.parse(row.as_of) : NaN;
  const age = Date.now() - quotedAt;
  if (row.is_delayed || (row.market_state === "open" && age > 10 * 60 * 1000))
    return "Delayed";
  if (!Number.isFinite(quotedAt)) return "Time unavailable";
  if (row.market_state === "closed") return "Market closed";
  if (row.degraded) return "";
  return age > 10 * 60 * 1000 ? "Snapshot" : "Latest quote";
}

function toIndexOverviewMetric(
  row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null,
  fallbackLabel: string,
): MarketOverviewMetric {
  const degraded = !row || Boolean(row.degraded);
  const label = String(row?.label || fallbackLabel);
  const tone = toOverviewTone(row?.delta_pct, degraded);
  const value = formatOverviewValue(row?.value, { label, degraded });
  const delta = formatOverviewDelta(row?.delta_pct, {
    label,
    degraded,
  });
  const sparkline = Array.isArray(row?.sparkline)
    ? row.sparkline.filter(
        (point): point is number =>
          typeof point === "number" && Number.isFinite(point),
      )
    : undefined;
  return {
    id: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    value,
    delta,
    tone,
    icon: iconForOverview(label, tone),
    degraded,
    quoteStatus: indexQuoteStatus(row),
    quotedAt: row?.as_of && Number.isFinite(Date.parse(row.as_of)) ? row.as_of : null,
    sparkline: sparkline && sparkline.length >= 2 ? sparkline : undefined,
    detailPanel: buildIndexDetailPanel(row, label, value, delta, tone),
  };
}

function toThemeIcon(title: string): LucideIcon {
  const matched = THEME_ICON_MAP.find((row) => row.test.test(title));
  return matched?.icon || LineChart;
}

function isDummyTheme(
  theme: NonNullable<KaiHomeInsightsV2["themes"]>[number],
): boolean {
  const sourceTags = Array.isArray(theme.source_tags)
    ? theme.source_tags.map((tag) => String(tag || "").toLowerCase())
    : [];
  const hasFallbackTag = sourceTags.some(
    (tag) => tag.includes("fallback") || tag.includes("dummy"),
  );
  const subtitle = String(theme.subtitle || "")
    .trim()
    .toLowerCase();
  const hasHeadline = Boolean(String(theme.headline || "").trim());
  return (
    Boolean(theme.degraded) &&
    (hasFallbackTag || (!hasHeadline && subtitle.includes("sector rotation")))
  );
}

function toThemeItems(payload: KaiHomeInsightsV2 | null): ThemeFocusItem[] {
  const themes = payload?.themes || [];
  if (!Array.isArray(themes)) return [];
  return themes
    .filter(
      (theme): theme is NonNullable<KaiHomeInsightsV2["themes"]>[number] =>
        Boolean(theme),
    )
    .filter((theme) => !isDummyTheme(theme))
    .map((theme, idx) => ({
      id: `${String(theme.title || "theme")}-${idx}`,
      title: String(theme.title || "Theme"),
      subtitle: String(theme.subtitle || "Sector focus"),
      icon: toThemeIcon(String(theme.title || "")),
    }))
    .slice(0, 3);
}

function formatStatusUpdatedLabel(asOf: unknown): string | null {
  if (typeof asOf !== "string" || !asOf.trim()) return null;
  const updated = new Date(asOf);
  if (Number.isNaN(updated.getTime())) return null;
  const diffMs = Date.now() - updated.getTime();
  if (diffMs < 0) {
    return "Updated just now";
  }
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "Updated just now";
  if (diffMinutes === 1) return "Updated 1 min ago";
  if (diffMinutes < 60) return `Updated ${diffMinutes} min ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return "Updated 1 hr ago";
  if (diffHours < 24) return `Updated ${diffHours} hrs ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Updated 1 day ago";
  return `Updated ${diffDays} days ago`;
}

function marketStatusBadge(payload: KaiHomeInsightsV2 | null): {
  label: string;
  className: string;
  isOpen: boolean;
  degraded: boolean;
  source: string | null;
  updatedLabel: string | null;
} | null {
  const row = payload?.market_overview?.find((candidate) =>
    String(candidate.label || "")
      .toLowerCase()
      .includes("market status"),
  );
  if (!row) return null;
  const value = formatOverviewValue(row.value, {
    label: String(row.label || "Market Status"),
    degraded: Boolean(row.degraded),
  });
  if (!value) return null;

  const degraded = Boolean(row.degraded);
  const isOpen = value.toLowerCase().includes("open");
  const source =
    typeof row.source === "string" && row.source.trim()
      ? row.source.trim()
      : null;
  const updatedLabel = formatStatusUpdatedLabel(row.as_of);

  if (degraded) {
    return {
      label: value,
      isOpen,
      degraded,
      source,
      updatedLabel,
      className:
        "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  if (isOpen) {
    return {
      label: value,
      isOpen,
      degraded,
      source,
      updatedLabel,
      className:
        "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  return {
    label: value,
    isOpen,
    degraded,
    source,
    updatedLabel,
    className: "border-border/70 bg-background/80 text-muted-foreground",
  };
}

export function KaiMarketPreviewView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const localPreviewPayload = useMemo(() => {
    const enabled = isLocalMarketPreviewRequest({
      pathname,
      searchParams,
      hostname: typeof window === "undefined" ? null : window.location.hostname,
    });
    return enabled ? getLocalMarketPreviewPayload() : null;
  }, [pathname, searchParams]);
  const {
    payload,
    loading,
    refreshing,
    error,
    activePickSource,
    loadInsights,
  } = useKaiMarketHome();
  const [retainedPayload, setRetainedPayload] =
    useState<KaiHomeInsightsV2 | null>(payload);
  const usingLocalPreviewFallback = Boolean(localPreviewPayload && !payload);
  const displayPayload = payload ?? localPreviewPayload;
  const displayLoading = usingLocalPreviewFallback ? false : loading;
  const displayRefreshing = usingLocalPreviewFallback ? false : refreshing;
  const displayError = usingLocalPreviewFallback ? null : error;
  const [selectedOverviewMetricId, setSelectedOverviewMetricId] = useState<
    string | null
  >(null);
  const [sectorScopeAvailable, setSectorScopeAvailable] = useState(false);

  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();

  useEffect(() => {
    if (displayPayload) {
      setRetainedPayload(displayPayload);
    }
  }, [displayPayload]);

  const effectivePayload = displayPayload ?? retainedPayload;
  const marketPaneActive = !searchParams?.get("tab") || searchParams.get("tab") === "market";
  const hasPayload = Boolean(effectivePayload);
  const pickRows = useMemo(
    () =>
      Array.isArray(effectivePayload?.pick_rows)
        ? effectivePayload.pick_rows.filter((row) => Boolean(row?.symbol))
        : Array.isArray(effectivePayload?.renaissance_list)
          ? effectivePayload.renaissance_list.filter((row) =>
              Boolean(row?.symbol),
            )
          : [],
    [effectivePayload],
  );
  const indexStripItems = useMemo(
    () => toIndexStripItems(effectivePayload),
    [effectivePayload],
  );
  const selectedOverviewMetric = useMemo(
    () =>
      selectedOverviewMetricId
        ? indexStripItems.find(
            (metric) =>
              (metric.id || metric.label) === selectedOverviewMetricId,
          ) || null
        : null,
    [indexStripItems, selectedOverviewMetricId],
  );
  const retainedOverviewMetric = useRetainedSurfaceSelection(
    selectedOverviewMetric,
  );
  const marketStatus = useMemo(
    () => marketStatusBadge(effectivePayload),
    [effectivePayload],
  );
  const themeItems = useMemo(
    () => toThemeItems(effectivePayload),
    [effectivePayload],
  );
  const spotlightRows = useMemo(
    () =>
      Array.isArray(effectivePayload?.spotlights)
        ? effectivePayload.spotlights
            .filter((row) => Boolean(row?.symbol))
            .slice(0, 2)
        : [],
    [effectivePayload],
  );
  const scenarioSignals = useMemo(
    () =>
      Array.isArray(effectivePayload?.signals)
        ? effectivePayload.signals
            .filter((signal) => Boolean(signal?.id))
            .slice(0, 3)
        : [],
    [effectivePayload],
  );
  const showConnectPortfolio = useMemo(() => {
    if (!hasPayload) return false;
    if (effectivePayload?.meta?.market_mode !== "personalized") return false;
    const count = Number(effectivePayload?.hero?.holdings_count ?? 0);
    return !Number.isFinite(count) || count <= 0;
  }, [effectivePayload, hasPayload]);
  const marketVoiceSurfaceMetadata = useMemo(() => {
    const sectorVoiceInventory = getMarketSectorPeriodVoiceInventory(
      marketPaneActive && Boolean(effectivePayload?.sector_rotation?.length),
      sectorScopeAvailable,
    );
    const sections = [
      {
        id: "market_overview",
        title: "Market briefing",
        purpose:
          "Shows benchmark index levels, session changes, and quote freshness.",
      },
      {
        id: "market_news",
        title: "Market news",
        purpose: "Presents the lead company story and recent market headlines.",
      },
      {
        id: "sector_rotation",
        title: "Sector rotation",
        purpose: "Compares sector returns over one day or five trading sessions.",
      },
      {
        id: "market_movers",
        title: "Market movers",
        purpose: "Shows the available movers and losers with quote freshness.",
      },
      ...(showConnectPortfolio
        ? [
            {
              id: "portfolio_context",
              title: "Bring your own positions",
              purpose:
                "Explains how connecting a portfolio personalizes the market surface.",
            },
          ]
        : []),
    ];
    const actions = [
      {
        id: "kai.market.refresh",
        label: "Refresh market home",
        purpose:
          "Refreshes the current market overview, signals, and discovery modules.",
        voiceAliases: ["refresh market", "refresh market home"],
      },
      ...sectorVoiceInventory.actions,
      ...(hasPayload ? [{
        id: "route.kai_analysis",
        label: "Analyze a stock",
        purpose: "Opens Stocks for company facts and stock analysis.",
        voiceAliases: ["analyze a stock", "open stock analysis"],
      }] : []),
      ...(showConnectPortfolio
        ? [
            {
              id: "route.kai_dashboard",
              label: "Connect portfolio",
              purpose:
                "Opens portfolio setup so One can personalize this market surface.",
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
      ...sectorVoiceInventory.controls,
      ...(showConnectPortfolio
        ? [
            {
              id: "connect_portfolio",
              label: "Connect portfolio",
              purpose:
                "Opens portfolio connection so this surface can use your positions.",
              actionId: "route.kai_dashboard",
              role: "button",
              voiceAliases: ["connect portfolio"],
            },
          ]
        : []),
    ];
    const visibleModules = sections.map((section) => section.title);
    const marketMode =
      String(effectivePayload?.meta?.market_mode || "baseline").trim() ||
      "baseline";

    return {
      screenId: "kai_market",
      title: "Market",
      purpose:
        "This screen brings together current market performance, advisor signals, and discovery.",
      primaryEntity: null,
      sections,
      actions,
      controls,
      concepts: [
        {
          id: "market",
          label: "Market",
          explanation:
            "Market brings together current market performance, signals, and discovery.",
          aliases: ["market", "market home", "kai home"],
        },
      ],
      activeSection:
        displayRefreshing || displayLoading
          ? "Market briefing"
          : showConnectPortfolio
            ? "Bring your own positions"
            : "Market news",
      visibleModules,
      focusedWidget:
        displayRefreshing || displayLoading
          ? "Market briefing"
          : "Market news",
      availableActions: actions.map((action) => action.label),
      activeControlId: activeVoiceControlId,
      lastInteractedControlId: lastVoiceControlId,
      busyOperations: [
        ...(displayLoading ? ["market_initial_load"] : []),
        ...(displayRefreshing ? ["market_refresh"] : []),
      ],
      screenMetadata: {
        market_mode: marketMode,
        market_status_label: marketStatus?.label || null,
        has_payload: hasPayload,
        has_error: Boolean(displayError),
        active_pick_source: activePickSource,
        pick_row_count: pickRows.length,
        spotlight_count: spotlightRows.length,
        signal_count: scenarioSignals.length,
        theme_count: themeItems.length,
        news_count: Array.isArray(effectivePayload?.news_tape)
          ? effectivePayload.news_tape.length
          : 0,
        connect_portfolio_visible: showConnectPortfolio,
        holdings_count:
          Number(effectivePayload?.hero?.holdings_count ?? 0) || 0,
      },
    };
  }, [
    activePickSource,
    activeVoiceControlId,
    effectivePayload,
    displayError,
    hasPayload,
    lastVoiceControlId,
    displayLoading,
    marketStatus?.label,
    marketPaneActive,
    pickRows.length,
    displayRefreshing,
    scenarioSignals.length,
    sectorScopeAvailable,
    showConnectPortfolio,
    spotlightRows.length,
    themeItems.length,
  ]);
  usePublishVoiceSurfaceMetadata(marketVoiceSurfaceMetadata);

  const moverGroups = useMemo(
    () => toMoverGroups(effectivePayload),
    [effectivePayload],
  );
  const effectiveNewsTape = effectivePayload?.news_tape;
  const marketNewsRows = useMemo(
    () =>
      diversifyMarketNewsRows(
        Array.isArray(effectiveNewsTape) ? effectiveNewsTape : [],
      ),
    [effectiveNewsTape],
  );
  const sectorRotationRows = useMemo(
    () =>
      Array.isArray(effectivePayload?.sector_rotation)
        ? effectivePayload.sector_rotation
        : [],
    [effectivePayload],
  );

  return (
    <div
      className={cn(oneMarketRootClassName, marketBriefingStyles.typography)}
      data-one-market-surface="true"
      data-one-market-preview={localPreviewPayload ? "true" : undefined}
    >
      {localPreviewPayload ? (
        <style>
          {`
            html:has([data-one-market-preview="true"]),
            body {
              background: var(--background) !important;
            }

            body:has([data-one-market-preview="true"]) main,
            body:has([data-one-market-preview="true"]) [data-top-content-anchor="true"],
            body:has([data-one-market-preview="true"]) [class*="overflow-y-auto"][class*="touch-pan-y"] {
              background: var(--background) !important;
            }

            html.dark:has([data-one-market-preview="true"]),
            html.dark:has([data-one-market-preview="true"]) body,
            html.dark:has([data-one-market-preview="true"]) body main,
            html.dark:has([data-one-market-preview="true"]) body [data-top-content-anchor="true"],
            html.dark:has([data-one-market-preview="true"]) body [class*="overflow-y-auto"][class*="touch-pan-y"] {
              background: var(--background) !important;
            }

            nextjs-portal,
            [aria-label="Open consent inbox"] {
              display: none !important;
            }
          `}
        </style>
      ) : null}
      <div className="flex-1 pb-6 pt-0">
        <div className="sr-only"><KaiWorkspaceHeader workspace="market" title="Market" /></div>

        <AppPageContentRegion>
          <SurfaceCard>
          <SurfaceCardContent className={marketBriefingStyles.cardBody}>
          <OneMarketSectionHeader title="US markets" actions={
            <div className="flex items-center gap-1">
            {marketStatus ? <span data-testid="market-header-status" className="inline-flex min-h-8 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
              <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", marketStatus.isOpen && !marketStatus.degraded ? "bg-[color:var(--one-up)]" : "bg-muted-foreground")} />
              {marketStatus.label}
            </span> : null}
            <ShellActionSurface aria-label="Refresh market home" disabled={displayRefreshing}
              onClick={() => void loadInsights({ manual: true })}
              className="h-11 w-11"
              >
              {displayRefreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            </ShellActionSurface>
            </div>
          } />
          <OneMarketIndexStrip
            metrics={indexStripItems}
            onMetricSelect={(metric) =>
              setSelectedOverviewMetricId(metric.id || metric.label)
            }
          />
          </SurfaceCardContent>
          </SurfaceCard>

          {displayLoading && !hasPayload ? (
            <div className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-[var(--app-card-radius-compact)] bg-[color:var(--one-card)] p-5 text-center text-[14px] text-[color:var(--one-fg2)] shadow-[var(--app-card-shadow-standard)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <p>Loading your market view.</p>
              </div>
            </div>
          ) : null}

          {displayError && !hasPayload ? (
            <div className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <div className="space-y-3 rounded-[var(--app-card-radius-compact)] bg-[color:var(--one-card)] p-4 text-left shadow-[var(--app-card-shadow-standard)]">
                <div className="flex items-center gap-2 text-[color:var(--one-down)]">
                  <AlertTriangle className="h-4 w-4" />
                  <p className="text-[14px] font-semibold">
                    Failed to load market home
                  </p>
                </div>
                <p className="text-[12px] leading-relaxed text-[color:var(--one-fg2)]">
                  {displayError}
                </p>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => void loadInsights({ manual: true })}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : null}

          {displayError && hasPayload ? (
            <div className="mx-auto mt-5 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <div className="flex items-center justify-between gap-3 rounded-[var(--app-card-radius-compact)] bg-[color:var(--one-card)] p-3 text-left text-[12px] text-[color:var(--one-fg2)] shadow-[var(--app-card-shadow-standard)]">
                <span className="flex min-w-0 items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[color:var(--one-down)]" />
                  <span className="truncate">
                    Showing saved data. Couldn&apos;t refresh just now.
                  </span>
                </span>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => void loadInsights({ manual: true })}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : null}

          {hasPayload ? (
            <div className={marketBriefingStyles.sections}>
              <section aria-label="Market news">
                <OneMarketSectionHeader title="Market news" actionLabel="All news" actionHref={ROUTES.KAI_NEWS} />
                <SurfaceCard><SurfaceCardContent className={marketBriefingStyles.cardBody}>
                <OneMarketNewsBriefing rows={marketNewsRows} />
                </SurfaceCardContent></SurfaceCard>
              </section>

              <div className={sectorRotationRows.length ? marketBriefingStyles.activity : "grid"}>
                {sectorRotationRows.length ? (
                  <section className="min-w-0" aria-label="Sector rotation">
                    <OneMarketSectionHeader title="Sector rotation" />
                    <SurfaceCard><SurfaceCardContent className={marketBriefingStyles.cardBody}>
                    <SectorRotationChart rows={sectorRotationRows} active={marketPaneActive} onScopeAvailabilityChange={setSectorScopeAvailable} />
                    </SurfaceCardContent></SurfaceCard>
                  </section>
                ) : null}
                <section className="min-w-0" aria-label="Market movers">
                  <OneMarketSectionHeader title="Market movers" />
                  <SurfaceCard><SurfaceCardContent className={marketBriefingStyles.moversBody}>
                  <OneMarketMovers groups={moverGroups} />
                  </SurfaceCardContent></SurfaceCard>
                </section>
              </div>

              {showConnectPortfolio ? (
                <section><PermissionGate permission="portfolio_valuation"><ConnectPortfolioCta /></PermissionGate></section>
              ) : null}
            </div>
          ) : null}
        </AppPageContentRegion>
      </div>

      <MarketIndexDetailSurface
        open={Boolean(selectedOverviewMetric?.detailPanel)}
        metric={retainedOverviewMetric}
        onOpenChange={(open) => {
          if (!open) setSelectedOverviewMetricId(null);
        }}
      />
    </div>
  );
}
