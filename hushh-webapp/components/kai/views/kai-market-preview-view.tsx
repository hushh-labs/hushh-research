"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ChartColumnIncreasing,
  Cpu,
  LineChart,
  Loader2,
  Newspaper,
  Percent,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
  type LucideIcon,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { ConnectPortfolioCta } from "@/components/kai/cards/connect-portfolio-cta";
import { RiaPicksList } from "@/components/kai/cards/renaissance-market-list";
import { getCompanyLogoUrl } from "@/components/kai/shared/symbol-avatar";
import { PermissionGate } from "@/components/privacy/permission-gate/permission-gate";
import {
  type MarketOverviewDetailPanel,
  type MarketOverviewMetric,
} from "@/components/kai/cards/market-overview-grid";
import {
  kaiPreviewEyebrowClassName,
  kaiPreviewPageTitleClassName,
  kaiPreviewSectionTitleClassName,
  marketSurfaceVariablesClassName,
} from "@/components/kai/shared/market-surface-theme";
import {
  getLocalMarketPreviewPayload,
  isLocalMarketPreviewRequest,
} from "@/components/kai/shared/local-market-preview";
import type { ThemeFocusItem } from "@/components/kai/cards/theme-focus-list";
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
import { sanitizeErrorMessage } from "@/lib/services/error-sanitizer";
import { ensureKaiVaultOwnerToken } from "@/lib/services/kai-token-guard";
import {
  type KaiHomeInsightsV2,
  type KaiHomeNewsItem,
  type KaiHomePickSource,
  type KaiHomeRenaissanceItem,
  type KaiHomeSectorItem,
  type KaiHomeWatchlistItem,
} from "@/lib/services/api-service";
import {
  getKaiActivePickSource,
  setKaiActivePickSource,
} from "@/lib/kai/pick-source-selection";
import {
  openExternalUrl,
  requestInternalAppNavigation,
} from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";

function useRetainedSurfaceSelection<T>(selection: T | null, delayMs = 180): T | null {
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

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

function normalizeMarketSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function normalizeTrackedSymbols(symbols: string[] | null | undefined): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((symbol) => normalizeMarketSymbol(symbol))
    .filter(Boolean)
    .filter((symbol, index, arr) => arr.indexOf(symbol) === index)
    .slice(0, 8);
}

function normalizeAllSymbols(symbols: string[] | null | undefined): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((symbol) => normalizeMarketSymbol(symbol))
    .filter(Boolean)
    .filter((symbol, index, arr) => arr.indexOf(symbol) === index);
}

const THEME_ICON_MAP: Array<{ test: RegExp; icon: LucideIcon }> = [
  { test: /ai|chip|semi|data|cloud|infra/i, icon: Cpu },
  { test: /rate|yield|inflation|macro/i, icon: Percent },
  { test: /energy|oil|gas|renewable|power/i, icon: Zap },
];

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

const oneMarketRootClassName = cn(
  marketSurfaceVariablesClassName,
  "relative isolate mx-auto flex min-h-screen w-full !max-w-none flex-col overflow-x-hidden !px-0 pb-0",
  "bg-[color:var(--one-bg)] font-sans text-[color:var(--one-fg)] antialiased",
  // The page background always matches the app shell (--background) so the
  // route never paints its own lighter panel inside the shell (the "double
  // layout" partition). Cards/surfaces are background-derived elevations.
  "[--one-bg:var(--background)] [--one-card:#ffffff] [--one-surface:#f2f2f7]",
  "dark:[--one-bg:var(--background)]",
  "dark:[--one-card:color-mix(in_oklab,var(--background)_88%,white)]",
  "dark:[--one-surface:color-mix(in_oklab,var(--background)_88%,white)]",
  "[--one-hairline:rgba(0,0,0,0.08)] [--one-line:rgba(0,0,0,0.06)]",
  "dark:[--one-hairline:rgba(255,255,255,0.14)] dark:[--one-line:rgba(255,255,255,0.10)]",
  "[--one-fg:#1d1d1f] [--one-fg2:rgba(0,0,0,0.55)] [--one-fg3:rgba(0,0,0,0.42)]",
  "dark:[--one-fg:#f5f5f7] dark:[--one-fg2:rgba(245,245,247,0.64)] dark:[--one-fg3:rgba(245,245,247,0.46)]",
  "[--one-blue:var(--app-accent)] [--one-link:var(--app-accent-deep)]",
  "dark:[--one-blue:var(--app-accent)] dark:[--one-link:var(--app-accent-deep)]",
  "[--one-up:#34c759] [--one-up-t:rgba(52,199,89,0.12)]",
  "[--one-down:#ff3b30] [--one-down-t:rgba(255,59,48,0.10)]",
  "[--one-indigo:#5856d6] [--one-indigo-t:rgba(88,86,214,0.12)]",
  "[--one-orange:#ff9500] [--one-orange-t:rgba(255,149,0,0.14)]",
  "[--one-teal:#30b0c7] [--one-teal-t:rgba(48,176,199,0.13)]",
  "[--one-glass-fill:linear-gradient(135deg,rgba(255,255,255,0.45),rgba(255,255,255,0.16))]",
  "dark:[--one-glass-fill:linear-gradient(135deg,rgba(44,44,46,0.86),rgba(28,28,30,0.62))]",
  "[--one-glass-float:0_16px_38px_-20px_rgba(0,0,0,0.28),0_4px_12px_-8px_rgba(0,0,0,0.10)]",
  "[--one-gutter:clamp(18px,4vw,32px)]"
);

type OneMarketDisplayRow = {
  symbol: string;
  companyName: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  sparkline?: number[] | null;
};

type OneMarketMoverTab = "gain" | "lose" | "active";
type OneMarketNewsTone = "positive" | "negative" | "neutral";

function formatOneMarketPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatOneMarketPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Live";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatOneMarketVolume(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Volume live";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B vol`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M vol`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K vol`;
  return `${value.toFixed(0)} vol`;
}

function oneMarketTone(value: number | null | undefined): "up" | "down" | "neutral" {
  if (typeof value !== "number" || !Number.isFinite(value)) return "neutral";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

function toOneMarketRows(
  rows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem | NonNullable<KaiHomeInsightsV2["movers"]>["gainers"][number]> | null | undefined
): OneMarketDisplayRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const sparklineSource = (row as { sparkline?: unknown } | null | undefined)?.sparkline;
      const sparkline =
        Array.isArray(sparklineSource) && sparklineSource.length > 1
          ? sparklineSource.filter(
              (point): point is number => typeof point === "number" && Number.isFinite(point)
            )
          : null;
      return {
        symbol: normalizeMarketSymbol(row?.symbol),
        companyName: String(row?.company_name || row?.symbol || "Market name").trim(),
        price: typeof row?.price === "number" && Number.isFinite(row.price) ? row.price : null,
        changePct:
          typeof row?.change_pct === "number" && Number.isFinite(row.change_pct)
            ? row.change_pct
            : null,
        volume: typeof row?.volume === "number" && Number.isFinite(row.volume) ? row.volume : null,
        sparkline: sparkline && sparkline.length > 1 ? sparkline : null,
      };
    })
    .filter((row) => Boolean(row.symbol));
}

function dedupeOneMarketRows(rows: OneMarketDisplayRow[]): OneMarketDisplayRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toMoverGroups(
  payload: KaiHomeInsightsV2 | null
): Record<OneMarketMoverTab, OneMarketDisplayRow[]> {
  const gainers = dedupeOneMarketRows(toOneMarketRows(payload?.movers?.gainers)).slice(0, 4);
  const losers = dedupeOneMarketRows(toOneMarketRows(payload?.movers?.losers)).slice(0, 4);
  const active = dedupeOneMarketRows(toOneMarketRows(payload?.movers?.active))
    .sort((left, right) => Number(right.volume || 0) - Number(left.volume || 0))
    .slice(0, 4);
  return { gain: gainers, lose: losers, active };
}

function toIndexStripItems(
  payload: KaiHomeInsightsV2 | null,
  fallbackMetrics: MarketOverviewMetric[]
): MarketOverviewMetric[] {
  const overviewRows = Array.isArray(payload?.market_overview)
    ? payload.market_overview.filter(
        (row) => Boolean(row?.label) && !String(row.label).toLowerCase().includes("market status")
      )
    : [];

  const hasUsableOverviewRow = (
    row: NonNullable<KaiHomeInsightsV2["market_overview"]>[number] | null | undefined
  ) => {
    if (!row || row.degraded) return false;
    if (typeof row.value === "number" && Number.isFinite(row.value)) return true;
    return typeof row.value === "string" && row.value.trim() !== "" && !isUnavailableText(row.value);
  };

  const benchmarkRows = [
    { label: "S&P 500", match: (label: string) => label.includes("s&p") || label.includes("sp 500") },
    { label: "NASDAQ 100", match: (label: string) => label.includes("nasdaq") },
    { label: "DOW 30", match: (label: string) => label.includes("dow") },
    { label: "Russell 2000", match: (label: string) => label.includes("russell") },
  ]
    .map(({ label, match }) => {
      const row = overviewRows.find((candidate) => match(String(candidate.label || "").toLowerCase())) || null;
      return hasUsableOverviewRow(row) ? toIndexOverviewMetric(row, label) : toIndexOverviewMetric(null, label);
    });

  const providerRows = overviewRows
    .filter(hasUsableOverviewRow)
    .map((row) => toIndexOverviewMetric(row, String(row.label || "Market")));
  const nonDelayedFallbackRows = fallbackMetrics.filter(
    (metric) =>
      !/delayed/i.test(`${metric.value} ${metric.delta}`) &&
      !/delayed/i.test(metric.detailPanel?.statusLabel || "")
  );
  const seen = new Set<string>();
  return [...benchmarkRows, ...providerRows, ...nonDelayedFallbackRows]
    .filter((metric) => {
      const key = metric.id || metric.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function openOneMarketHref(href: string) {
  if (/^https?:\/\//i.test(href)) {
    openExternalUrl(href);
    return;
  }
  requestInternalAppNavigation({ href, scroll: false });
}

function oneMarketNewsTone(row: KaiHomeNewsItem): OneMarketNewsTone {
  const sentiment = String(row.sentiment_hint || "").toLowerCase();
  if (sentiment.includes("positive")) return "positive";
  if (sentiment.includes("negative")) return "negative";
  return "neutral";
}

function oneMarketNewsCoverClassName(row: KaiHomeNewsItem): string {
  const tone = oneMarketNewsTone(row);
  if (tone === "positive") return "bg-[color:var(--one-up)]";
  if (tone === "negative") return "bg-[color:var(--one-down)]";
  return "bg-[#8e8e93]";
}

function oneMarketNewsContext(row: KaiHomeNewsItem): string {
  const title = String(row.title || "").toLowerCase();
  const sentiment = String(row.sentiment_hint || "").toLowerCase();

  if (title.includes("data") || title.includes("ai") || title.includes("chip") || title.includes("semiconductor")) {
    return "AI and infrastructure read - useful for cloud, software, and chip exposure.";
  }
  if (title.includes("defensive") || title.includes("staple")) {
    return "Defensive rotation read - check staples exposure and downside protection.";
  }
  if (title.includes("ev") || title.includes("auto")) {
    return "High-beta move - review entry discipline and position sizing.";
  }
  if (title.includes("cloud") || title.includes("device") || title.includes("services")) {
    return "Quality tech read - watch demand, services, and cash-flow durability.";
  }
  if (title.includes("marketplace") || title.includes("commerce")) {
    return "Platform read - marketplace and cloud strength can shape tech breadth.";
  }
  if (sentiment.includes("positive")) {
    return "Positive tape read - useful for watchlist momentum and sector leadership.";
  }
  if (sentiment.includes("negative")) {
    return "Risk read - check exposed holdings before the next market open.";
  }
  return "Market context - use it to confirm the current rotation before acting.";
}

function OneMarketNewsGlyph({ row }: { row: KaiHomeNewsItem }) {
  const symbol = normalizeMarketSymbol(row.symbol);
  return <>{symbol.slice(0, 1) || "N"}</>;
}

function BrandLogo({
  symbol,
  className,
}: {
  symbol: string;
  className?: string;
}) {
  const normalized = normalizeMarketSymbol(symbol);
  const logoUrl = getCompanyLogoUrl({ symbol: normalized });
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);

  const baseClassName =
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[color:var(--one-surface)] text-[color:var(--one-fg)]";

  if (logoUrl && !logoFailed) {
    return (
      <span className={cn(baseClassName, "border border-[color:var(--one-hairline)] bg-white", className)} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt=""
          className="h-[62%] w-[62%] object-contain"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className={cn(baseClassName, "font-bold text-[11px]", className)} aria-hidden="true">
      {normalized.slice(0, 4)}
    </span>
  );
}

function OneMarketSectionHeader({
  title,
  icon: Icon,
  tone,
  actionLabel,
  actionHref,
}: {
  title: string;
  icon: LucideIcon;
  tone: "indigo" | "orange" | "teal";
  actionLabel?: string;
  actionHref?: string;
}) {
  const toneClassName =
    tone === "indigo"
      ? "bg-[color:var(--one-indigo-t)] text-[color:var(--one-indigo)]"
      : tone === "orange"
        ? "bg-[color:var(--one-orange-t)] text-[color:var(--one-orange)]"
        : "bg-[color:var(--one-teal-t)] text-[color:var(--one-teal)]";
  return (
    <div className="mb-3.5 flex items-center justify-between">
      <div className={kaiPreviewSectionTitleClassName} role="heading" aria-level={2}>
        <span className={cn("grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg", toneClassName)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {actionLabel ? (
        <button
          type="button"
          onClick={() => {
            if (actionHref) openOneMarketHref(actionHref);
          }}
          className="shrink-0 text-[13px] font-semibold text-[color:var(--one-link)]"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Honest, data-driven sparkline built on recharts. Renders the REAL series;
 * when no series exists it renders a flat dashed baseline instead of
 * inventing a chart shape. Stroke color follows the actual tone, never a
 * hardcoded "always up" green.
 */
function IndexSparkline({
  tone,
  series,
  height = 20,
}: {
  tone: MarketOverviewMetric["tone"] | undefined;
  series?: number[] | null;
  height?: number;
}) {
  const stroke =
    tone === "negative"
      ? "var(--one-down)"
      : tone === "positive"
        ? "var(--one-up)"
        : "var(--one-fg3)";

  if (!series || series.length < 2) {
    // No real data: flat neutral baseline, clearly "no chart" rather than a
    // fabricated trend.
    return (
      <svg
        className="mt-2 block h-5 w-full opacity-50"
        viewBox="0 0 100 20"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ height }}
      >
        <path
          d="M0 10 L100 10"
          fill="none"
          stroke="var(--one-fg3)"
          strokeWidth="1.4"
          strokeDasharray="3 4"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const chartData = series.map((value, index) => ({ index, value }));

  return (
    <div className="mt-2 w-full" style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsLineChart data={chartData} margin={{ top: 1, right: 1, left: 1, bottom: 1 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
}

function OneMarketIndexStrip({
  metrics,
  onMetricSelect,
}: {
  metrics: MarketOverviewMetric[];
  onMetricSelect: (metric: MarketOverviewMetric) => void;
}) {
  if (!metrics.length) return null;
  return (
    <div className="mx-auto flex w-full max-w-[1080px] gap-2.5 overflow-x-auto px-[var(--one-gutter)] pb-1 pt-[18px] [-ms-overflow-style:none] [scrollbar-width:none] sm:grid sm:grid-cols-4 sm:gap-3 sm:overflow-visible [&::-webkit-scrollbar]:hidden">
      {metrics.map((metric) => (
        <button
          key={metric.id || metric.label}
          type="button"
          onClick={() => onMetricSelect(metric)}
          className="w-[132px] shrink-0 rounded-2xl bg-[color:var(--one-card)] px-[15px] py-[13px] text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)] transition-transform duration-200 active:scale-[0.985] sm:w-full"
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium text-[color:var(--one-fg2)]">
              {metric.label}
            </span>
            {metric.degraded ? (
              <span className="shrink-0 rounded-full bg-[color:var(--one-orange-t)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.04em] text-[color:var(--one-orange)]">
                Delayed
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 text-[14px] font-semibold tabular-nums text-[color:var(--one-fg)]">
            {metric.value}
          </div>
          <div
            className={cn(
              "mt-0.5 text-[12px] font-semibold tabular-nums",
              metric.tone === "positive" && "text-[color:var(--one-up)]",
              metric.tone === "negative" && "text-[color:var(--one-down)]",
              metric.tone !== "positive" && metric.tone !== "negative" && "text-[color:var(--one-fg3)]"
            )}
          >
            {metric.delta}
          </div>
          <IndexSparkline
            tone={metric.degraded ? "neutral" : metric.tone}
            series={metric.degraded ? undefined : metric.sparkline}
          />
        </button>
      ))}
    </div>
  );
}

function OneMarketMoverRow({
  row,
  tab,
}: {
  row: OneMarketDisplayRow;
  tab: OneMarketMoverTab;
}) {
  const tone = oneMarketTone(row.changePct);
  return (
    <button
      type="button"
      onClick={() => openOneMarketHref(`${ROUTES.KAI_ANALYSIS}?symbol=${encodeURIComponent(row.symbol)}`)}
      className="flex w-full items-center gap-3 border-b border-[color:var(--one-line)] py-3.5 text-left last:border-b-0 active:bg-[color:var(--one-surface)]"
    >
      <BrandLogo symbol={row.symbol} className="h-9 w-9" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-semibold leading-tight text-[color:var(--one-fg)]">
          {row.companyName}
        </span>
        <span className="truncate text-[12px] text-[color:var(--one-fg3)]">
          {row.symbol} · NASDAQ
        </span>
      </span>
      {row.sparkline && row.sparkline.length >= 2 ? (
        <span className="hidden w-14 shrink-0 sm:block">
          <IndexSparkline tone={oneMarketTone(row.changePct) === "up" ? "positive" : oneMarketTone(row.changePct) === "down" ? "negative" : "neutral"} series={row.sparkline} height={22} />
        </span>
      ) : null}
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span className="text-[14px] font-semibold leading-tight tabular-nums text-[color:var(--one-fg)]">
          {formatOneMarketPrice(row.price)}
        </span>
        {tab === "active" ? (
          <span className="text-[12px] tabular-nums text-[color:var(--one-fg3)]">
            {formatOneMarketVolume(row.volume)}
          </span>
        ) : (
          <span
            className={cn(
              "text-[12px] font-semibold tabular-nums",
              tone === "up" && "text-[color:var(--one-up)]",
              tone === "down" && "text-[color:var(--one-down)]",
              tone === "neutral" && "text-[color:var(--one-fg3)]"
            )}
          >
            {formatOneMarketPercent(row.changePct)}
          </span>
        )}
      </span>
    </button>
  );
}

function OneMarketNewsCover({ row, index }: { row: KaiHomeNewsItem; index: number }) {
  const symbol = normalizeMarketSymbol(row.symbol);
  const logoUrl = getCompanyLogoUrl({ symbol });
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);

  const showLogo = Boolean(logoUrl) && !logoFailed;

  return (
    <div
      className={cn(
        "relative flex h-[116px] items-center justify-center overflow-hidden",
        "after:pointer-events-none after:absolute after:inset-y-0 after:-left-[80%] after:w-[60%] after:skew-x-[-20deg] after:bg-[linear-gradient(105deg,transparent,rgba(255,255,255,0.44),transparent)] after:transition-[left] after:duration-700 group-hover/news:after:left-[130%]",
        showLogo ? "bg-white" : oneMarketNewsCoverClassName(row)
      )}
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl ?? undefined}
          alt=""
          className="block h-[48%] w-[48%] shrink-0 object-contain"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <>
          <span className="relative text-[36px] font-semibold leading-none tracking-normal text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            <OneMarketNewsGlyph row={row} />
          </span>
          <svg
            className="absolute inset-x-0 bottom-0 h-10 w-full opacity-25"
            viewBox="0 0 100 30"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d={
                index % 3 === 1
                  ? "M0 24 L20 18 L40 22 L60 12 L80 16 L100 8 L100 30 L0 30 Z"
                  : index % 3 === 2
                    ? "M0 20 L20 24 L40 14 L60 18 L80 8 L100 12 L100 30 L0 30 Z"
                    : "M0 22 L20 16 L40 20 L60 10 L80 14 L100 6 L100 30 L0 30 Z"
              }
              fill="#ffffff"
            />
          </svg>
        </>
      )}
    </div>
  );
}

function SectorRotationChart({ rows }: { rows: KaiHomeSectorItem[] }) {
  const chartRows = useMemo(
    () =>
      rows
        .filter(
          (row): row is KaiHomeSectorItem & { change_pct: number } =>
            Boolean(row?.sector) &&
            typeof row.change_pct === "number" &&
            Number.isFinite(row.change_pct)
        )
        .map((row) => ({ sector: row.sector, changePct: row.change_pct }))
        .sort((left, right) => right.changePct - left.changePct)
        .slice(0, 8),
    [rows]
  );

  if (!chartRows.length) return null;

  return (
    <div className="w-full" style={{ height: Math.max(180, chartRows.length * 34) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartRows}
          layout="vertical"
          margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
        >
          <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--one-line)" />
          <XAxis
            type="number"
            tickFormatter={(value) => `${value >= 0 ? "+" : ""}${value}%`}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "var(--one-fg3)" }}
          />
          <YAxis
            type="category"
            dataKey="sector"
            axisLine={false}
            tickLine={false}
            width={110}
            tick={{ fontSize: 11, fill: "var(--one-fg2)" }}
          />
          <Bar dataKey="changePct" radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
            {chartRows.map((row) => (
              <Cell key={row.sector} fill={row.changePct >= 0 ? "var(--one-up)" : "var(--one-down)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OneMarketNewsCards({ rows }: { rows: KaiHomeNewsItem[] }) {
  const fallbackRows = rows.length
    ? rows
    : [
        {
          symbol: "KAI",
          title: "Defensives lead as indices slip. What it means for your portfolio",
          url: ROUTES.KAI_ANALYSIS,
          published_at: new Date().toISOString(),
          source_name: "Kai Wrap",
          provider: "local",
          degraded: false,
        },
      ];
  return (
    <div className="-mx-[var(--one-gutter)] flex gap-3 overflow-x-auto px-[var(--one-gutter)] pb-1 pt-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {fallbackRows.slice(0, 4).map((row, index) => (
        <button
          key={`${row.symbol}-${index}-${row.url}`}
          type="button"
          onClick={() => openOneMarketHref(row.url)}
          className="group/news flex w-[274px] shrink-0 flex-col overflow-hidden rounded-[18px] bg-[color:var(--one-card)] text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.22)] transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_20px_34px_-18px_rgba(0,0,0,0.26)] active:scale-[0.985] sm:w-[300px]"
        >
          <OneMarketNewsCover row={row} index={index} />
          <div className="flex flex-1 flex-col px-[13px] pb-[13px] pt-[11px]">
            <div className="mb-1.5 flex items-center justify-between gap-1.5 text-[11.5px] font-medium text-[color:var(--one-fg3)]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate">{row.source_name || "Market news"}</span>
                <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-[color:var(--one-fg3)]" />
                <span className="shrink-0">{formatHeadlinePublished(row.published_at)}</span>
              </span>
              <span className="shrink-0 rounded-full bg-[color:var(--one-surface)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--one-fg2)]">
                {normalizeMarketSymbol(row.symbol) || "NEWS"}
              </span>
            </div>
            <div className="line-clamp-2 text-[13.5px] font-semibold leading-[1.35] text-[color:var(--one-fg)]">
              {row.title}
            </div>
            <p className="mt-2 line-clamp-2 text-[12px] leading-[1.38] text-[color:var(--one-fg2)]">
              {oneMarketNewsContext(row)}
            </p>
            <div className="mt-3 flex items-center justify-end">
              <span className="shrink-0 text-[11px] font-semibold text-[color:var(--one-link)]">
                Read
              </span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function OneMarketNotificationsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <section
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[min(62vh,620px)] max-w-[720px] flex-col rounded-t-[28px] bg-white/95 shadow-[0_-18px_50px_-20px_rgba(0,0,0,0.40)] backdrop-blur-[20px] transition-transform duration-300",
        open ? "translate-y-0" : "translate-y-[105%]"
      )}
      aria-label="Notifications"
      aria-hidden={!open}
    >
      <div className="mx-auto mt-2.5 h-[5px] w-9 rounded-full bg-[color:var(--one-fg3)] opacity-35" />
      <header className="flex items-center gap-3 border-b border-[color:var(--one-line)] px-[18px] pb-3 pt-3">
        <span className="min-w-0 flex-1">
          <b className="block text-[17px] font-semibold text-[color:var(--one-fg)]">Notifications</b>
          <span className="block text-[12px] text-[color:var(--one-fg3)]">Signals and receipts</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg2)]"
          aria-label="Close notifications"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {[
          { title: "Receipt signed", body: "Banking agent · credit score · 30 min · revocable", time: "2m", icon: Activity, tone: "up" },
          { title: "Kai signal · Buy TSLA", body: "High conviction · 12+ month horizon", time: "1h", icon: Sparkles, tone: "blue" },
          { title: "Markets closed soft", body: "S&P 500 -1.58% · defensives led", time: "3h", icon: TrendingDown, tone: "down" },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="flex items-start gap-3 border-t border-[color:var(--one-line)] px-[18px] py-[13px] first:border-t-0">
              <span
                className={cn(
                  "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px]",
                  item.tone === "up" && "bg-[color:var(--one-up-t)] text-[color:var(--one-up)]",
                  item.tone === "down" && "bg-[color:var(--one-down-t)] text-[color:var(--one-down)]",
                  item.tone === "blue" && "bg-[color:var(--app-accent-tint)] text-[color:var(--one-link)]"
                )}
              >
                <Icon className="h-[17px] w-[17px]" />
              </span>
              <span className="min-w-0 flex-1">
                <b className="block text-[14px] font-semibold text-[color:var(--one-fg)]">{item.title}</b>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-[color:var(--one-fg2)]">
                  {item.body}
                </span>
              </span>
              <time className="shrink-0 text-[11.5px] text-[color:var(--one-fg3)]">{item.time}</time>
            </div>
          );
        })}
      </div>
    </section>
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
  // The strip renders a "Delayed" chip next to the label for degraded rows,
  // so the value slot stays factual instead of repeating "Data delayed".
  return degraded ? "Awaiting data" : "Updating";
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
    return degraded ? "Refresh pending" : "Live";
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
  const sparkline = Array.isArray(row?.sparkline)
    ? row.sparkline.filter((point): point is number =>
        typeof point === "number" && Number.isFinite(point)
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
    sparkline: sparkline && sparkline.length >= 2 ? sparkline : undefined,
    detailPanel: buildIndexDetailPanel(row, label, value, delta, tone),
  };
}

function toBreadthMetric(
  payload: KaiHomeInsightsV2 | null,
  pickRows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): MarketOverviewMetric {
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

  const higherToday = normalizeAllSymbols(
    pickRows
      .filter((row) => typeof row.change_pct === "number" && row.change_pct > 0)
      .sort((left, right) => Math.abs(Number(right.change_pct || 0)) - Math.abs(Number(left.change_pct || 0)))
      .map((row) => normalizeMarketSymbol(row.symbol))
  );
  const lowerToday = normalizeAllSymbols(
    pickRows
      .filter((row) => typeof row.change_pct === "number" && row.change_pct < 0)
      .sort((left, right) => Math.abs(Number(right.change_pct || 0)) - Math.abs(Number(left.change_pct || 0)))
      .map((row) => normalizeMarketSymbol(row.symbol))
  );
  const _topHigher = Array.isArray(movers?.gainers)
    ? movers.gainers
        .map((row) => normalizeMarketSymbol(row?.symbol))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const _topLower = Array.isArray(movers?.losers)
    ? movers.losers
        .map((row) => normalizeMarketSymbol(row?.symbol))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return {
    id: "breadth",
    label: "Advancers vs decliners",
    value,
    delta:
      trackedCount > 0
        ? `${gainers} higher · ${losers} lower`
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
      statusLabel: degraded ? "Breadth snapshot delayed" : "Breadth live",
      statusTone: tone,
      sections: [
        {
          title: "Participation",
          lines: [
            trackedCount > 0
              ? `${gainers} of ${trackedCount} tracked names are higher today.`
              : "Kai does not have a fresh breadth snapshot yet.",
            trackedCount > 0
              ? `${losers} tracked names are lower today.`
              : "The breadth feed is still warming.",
          ],
        },
        {
          title: "Higher today",
          lines: [
            higherToday.length
              ? `${higherToday.length} names are higher across the active watchlist.`
              : _topHigher.length
                ? `Leaders: ${_topHigher.join(", ")}`
                : "Higher-today names are still populating.",
          ],
          items: higherToday,
        },
        {
          title: "Lower today",
          lines: [
            lowerToday.length
              ? `${lowerToday.length} names are lower across the active watchlist.`
              : _topLower.length
                ? `Leaders: ${_topLower.join(", ")}`
                : "Lower-today names are still populating.",
          ],
          items: lowerToday,
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

function toOverviewMetrics(
  payload: KaiHomeInsightsV2 | null,
  pickRows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): MarketOverviewMetric[] {
  return [
    toIndexOverviewMetric(
      findOverviewRow(payload, (row) => String(row.label || "").toLowerCase().includes("s&p")),
      "S&P 500"
    ),
    toIndexOverviewMetric(
      findOverviewRow(payload, (row) => String(row.label || "").toLowerCase().includes("nasdaq")),
      "NASDAQ 100"
    ),
    toBreadthMetric(payload, pickRows),
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
  const row = findOverviewRow(payload, (candidate) =>
    String(candidate.label || "").toLowerCase().includes("market status")
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
    typeof row.source === "string" && row.source.trim() ? row.source.trim() : null;
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
    error: sanitizeMarketHomeError(
      payload
        ? personalizedResource.error || baselineResource.error
        : baselineResource.error || personalizedResource.error
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
    handlePickSourceChange,
  } = useKaiMarketHomeController();
  const [retainedPayload, setRetainedPayload] = useState<KaiHomeInsightsV2 | null>(payload);
  const usingLocalPreviewFallback = Boolean(localPreviewPayload && !payload);
  const displayPayload = payload ?? localPreviewPayload;
  const displayLoading = usingLocalPreviewFallback ? false : loading;
  const displayRefreshing = usingLocalPreviewFallback ? false : refreshing;
  const displayError = usingLocalPreviewFallback ? null : error;
  const [selectedOverviewMetricId, setSelectedOverviewMetricId] = useState<string | null>(null);
  const [moverTab, setMoverTab] = useState<OneMarketMoverTab>("gain");
  const [notificationsOpen, setNotificationsOpen] = useState(false);

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
  const hasPayload = Boolean(effectivePayload);
  const pickRows = useMemo(
    () =>
      Array.isArray(effectivePayload?.pick_rows)
        ? effectivePayload.pick_rows.filter((row) => Boolean(row?.symbol))
        : Array.isArray(effectivePayload?.renaissance_list)
          ? effectivePayload.renaissance_list.filter((row) => Boolean(row?.symbol))
          : [],
    [effectivePayload]
  );
  const riaPickRows = useMemo<KaiHomeRenaissanceItem[]>(
    () =>
      (Array.isArray(effectivePayload?.renaissance_list)
        ? effectivePayload.renaissance_list
        : Array.isArray(effectivePayload?.pick_rows)
          ? effectivePayload.pick_rows
          : []
      ).filter((row) => Boolean(row?.symbol)),
    [effectivePayload]
  );
  const overviewMetrics = useMemo(
    () => toOverviewMetrics(effectivePayload, pickRows),
    [effectivePayload, pickRows]
  );
  const selectedOverviewMetric = useMemo(
    () =>
      selectedOverviewMetricId
        ? overviewMetrics.find(
            (metric) => (metric.id || metric.label) === selectedOverviewMetricId
          ) || null
        : null,
    [overviewMetrics, selectedOverviewMetricId]
  );
  const retainedOverviewMetric = useRetainedSurfaceSelection(selectedOverviewMetric);
  const marketStatus = useMemo(() => marketStatusBadge(effectivePayload), [effectivePayload]);
  const themeItems = useMemo(() => toThemeItems(effectivePayload), [effectivePayload]);
  const pickSources = useMemo<KaiHomePickSource[]>(
    () =>
      Array.isArray(effectivePayload?.pick_sources)
        ? effectivePayload.pick_sources.filter((source) => Boolean(source?.id))
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
  const scenarioSignals = useMemo(
    () =>
      Array.isArray(effectivePayload?.signals)
        ? effectivePayload.signals.filter((signal) => Boolean(signal?.id)).slice(0, 3)
        : [],
    [effectivePayload]
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
              id: "route.kai_dashboard",
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
              actionId: "route.kai_dashboard",
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
        displayRefreshing || displayLoading
          ? "Market overview"
          : showConnectPortfolio
            ? "Bring your own positions"
            : "What matters now",
      visibleModules,
      focusedWidget:
        displayRefreshing || displayLoading
          ? "Market overview"
          : activePickSource !== "default"
            ? "RIA's picks"
            : "What matters now",
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
    displayError,
    hasPayload,
    lastVoiceControlId,
    displayLoading,
    marketStatus?.label,
    pickRows.length,
    pickSources.length,
    displayRefreshing,
    scenarioSignals.length,
    showConnectPortfolio,
    spotlightRows.length,
    themeItems.length,
  ]);
  usePublishVoiceSurfaceMetadata(marketVoiceSurfaceMetadata);

  const indexStripItems = useMemo(
    () => toIndexStripItems(effectivePayload, overviewMetrics),
    [effectivePayload, overviewMetrics]
  );
  const moverGroups = useMemo(
    () => toMoverGroups(effectivePayload),
    [effectivePayload]
  );
  const effectiveNewsTape = effectivePayload?.news_tape;
  const marketNewsRows = useMemo(
    () => (Array.isArray(effectiveNewsTape) ? effectiveNewsTape : []),
    [effectiveNewsTape]
  );
  const sectorRotationRows = useMemo(
    () => (Array.isArray(effectivePayload?.sector_rotation) ? effectivePayload.sector_rotation : []),
    [effectivePayload]
  );
  const shellOverlayOpen = notificationsOpen;
  const closeShellOverlays = useCallback(() => {
    setNotificationsOpen(false);
  }, []);

  return (
    <AppPageShell
      as="div"
      width="reading"
      className={oneMarketRootClassName}
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20 bg-[color:var(--one-bg)]"
      />
      <div className="flex-1 pb-[calc(148px+env(safe-area-inset-bottom))] pt-0">
        <header className="mx-auto w-full max-w-[1080px] px-[var(--one-gutter)] pt-4">
          <div className="flex items-start justify-between">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-[7px]",
                  marketStatus?.degraded
                    ? "text-[color:var(--one-fg3)]"
                    : marketStatus?.isOpen
                      ? "text-[color:var(--one-up)]"
                      : "text-[color:var(--one-fg2)]",
                  kaiPreviewEyebrowClassName
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    marketStatus?.degraded
                      ? "bg-[color:var(--one-fg3)]"
                      : marketStatus?.isOpen
                        ? "bg-[color:var(--one-up)]"
                        : "bg-[color:var(--one-fg2)]"
                  )}
                />
                {marketStatus?.label ?? "Live market"}
              </span>
              <div className={kaiPreviewPageTitleClassName} role="heading" aria-level={1}>
                Market
              </div>
              <p className="max-w-[34ch] text-[17px] leading-[1.42] text-[color:var(--one-fg2)]">
                Track the market and your watchlist.
              </p>
              {marketStatus?.updatedLabel || marketStatus?.source ? (
                <p className="text-[12px] leading-[1.3] text-[color:var(--one-fg3)]">
                  {[marketStatus?.updatedLabel, marketStatus?.source]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </div>
          </div>
        </header>

        <OneMarketIndexStrip
          metrics={indexStripItems}
          onMetricSelect={(metric) => setSelectedOverviewMetricId(metric.id || metric.label)}
        />

        {displayLoading && !hasPayload ? (
          <div className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
            <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-[18px] bg-[color:var(--one-card)] p-5 text-center text-[14px] text-[color:var(--one-fg2)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <p>Loading your market view.</p>
            </div>
          </div>
        ) : null}

        {displayError && !hasPayload ? (
          <div className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
            <div className="space-y-3 rounded-[18px] bg-[color:var(--one-card)] p-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              <div className="flex items-center gap-2 text-[color:var(--one-down)]">
                <AlertTriangle className="h-4 w-4" />
                <p className="text-[14px] font-semibold">
                  Failed to load market home
                </p>
              </div>
              <p className="text-[12px] leading-relaxed text-[color:var(--one-fg2)]">{displayError}</p>
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
            <div className="flex items-center justify-between gap-3 rounded-[18px] bg-[color:var(--one-card)] p-3 text-left text-[12px] text-[color:var(--one-fg2)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              <span className="flex min-w-0 items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[color:var(--one-down)]" />
                <span className="truncate">Showing saved data. Couldn&apos;t refresh just now.</span>
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
          <>
            <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <RiaPicksList
                rows={riaPickRows}
                sources={pickSources}
                activeSourceId={activePickSource}
                onSourceChange={handlePickSourceChange}
                controlMode="adaptive-surface"
              />
            </section>

            <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <OneMarketSectionHeader title="Top movers" icon={ChartColumnIncreasing} tone="orange" />
              <div className="mb-3.5 grid grid-cols-3 rounded-xl bg-[color:var(--one-surface)] p-[3px]">
                {[
                  { id: "gain" as const, label: "Gainers" },
                  { id: "lose" as const, label: "Losers" },
                  { id: "active" as const, label: "Most active" },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setMoverTab(tab.id)}
                    className={cn(
                      "rounded-[10px] px-1 py-2 text-center text-[13px] font-semibold text-[color:var(--one-fg2)] transition-colors",
                      moverTab === tab.id &&
                        "bg-[color:var(--one-card)] text-[color:var(--one-fg)] shadow-[0_1px_4px_rgba(0,0,0,0.14)]"
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div>
                {moverGroups[moverTab].length ? (
                  moverGroups[moverTab].map((row) => (
                    <OneMarketMoverRow key={`${moverTab}-${row.symbol}`} row={row} tab={moverTab} />
                  ))
                ) : (
                  <p className="py-3.5 text-[13px] text-[color:var(--one-fg3)]">
                    No movers to show right now.
                  </p>
                )}
              </div>
            </section>

            <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <OneMarketSectionHeader title="Market news" icon={Newspaper} tone="teal" actionLabel="More" actionHref={ROUTES.KAI_ANALYSIS} />
              <OneMarketNewsCards rows={marketNewsRows} />
            </section>

            {sectorRotationRows.length ? (
              <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
                <OneMarketSectionHeader title="Sector rotation" icon={ChartColumnIncreasing} tone="indigo" />
                <div className="rounded-2xl bg-[color:var(--one-card)] p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
                  <SectorRotationChart rows={sectorRotationRows} />
                </div>
              </section>
            ) : null}

            {showConnectPortfolio ? (
              <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
                <PermissionGate permission="portfolio_valuation">
                  <ConnectPortfolioCta />
                </PermissionGate>
              </section>
            ) : null}
          </>
        ) : null}
      </div>

      {shellOverlayOpen ? (
        <button
          type="button"
          aria-label="Close overlay"
          className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[6px]"
          onClick={closeShellOverlays}
        />
      ) : null}

      <OneMarketNotificationsSheet
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />

      <KaiControlSurface
        open={Boolean(selectedOverviewMetric?.detailPanel)}
        onOpenChange={(open) => {
          if (!open) setSelectedOverviewMetricId(null);
        }}
        eyebrow={retainedOverviewMetric?.detailPanel?.eyebrow}
        title={retainedOverviewMetric?.detailPanel?.title || "Overview detail"}
        description={retainedOverviewMetric?.detailPanel?.summary}
        contentClassName="sm:max-w-[min(36rem,calc(100vw-5rem))] lg:max-w-[min(38rem,calc(100vw-8rem))]"
        bodyClassName="px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 sm:px-6 sm:pt-5 lg:px-7"
      >
        {retainedOverviewMetric?.detailPanel ? (
          <div className="space-y-4">
            <SurfaceInset className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-2xl font-semibold tracking-normal text-foreground">
                    {retainedOverviewMetric.detailPanel.value || retainedOverviewMetric.value}
                  </p>
                  <p
                    className={cn(
                      "text-sm font-medium",
                      retainedOverviewMetric.detailPanel.statusTone === "positive" &&
                        "text-emerald-600 dark:text-emerald-400",
                      retainedOverviewMetric.detailPanel.statusTone === "negative" &&
                        "text-rose-600 dark:text-rose-400",
                      retainedOverviewMetric.detailPanel.statusTone === "warning" &&
                        "text-amber-700 dark:text-amber-300",
                      (!retainedOverviewMetric.detailPanel.statusTone ||
                        retainedOverviewMetric.detailPanel.statusTone === "neutral") &&
                        "text-muted-foreground"
                    )}
                  >
                    {retainedOverviewMetric.detailPanel.delta || retainedOverviewMetric.delta}
                  </p>
                </div>
                {retainedOverviewMetric.detailPanel.statusLabel ? (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] font-medium uppercase tracking-normal",
                      retainedOverviewMetric.detailPanel.statusTone === "positive" &&
                        "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      retainedOverviewMetric.detailPanel.statusTone === "negative" &&
                        "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
                      retainedOverviewMetric.detailPanel.statusTone === "warning" &&
                        "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                      (!retainedOverviewMetric.detailPanel.statusTone ||
                        retainedOverviewMetric.detailPanel.statusTone === "neutral") &&
                        "border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-muted-foreground"
                    )}
                  >
                    {retainedOverviewMetric.detailPanel.statusLabel}
                  </Badge>
                ) : null}
              </div>
            </SurfaceInset>

            {retainedOverviewMetric.detailPanel.sections?.map((section) => (
              <SurfaceInset key={section.title} className="space-y-2 p-4">
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
                  {section.title}
                </p>
                <div className="space-y-2">
                  {section.lines.map((line) => (
                    <p key={line} className="text-sm leading-6 text-foreground/90">
                      {line}
                    </p>
                  ))}
                  {section.items?.length ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {section.items.map((item) => (
                        <Badge
                          key={`${section.title}:${item}`}
                          variant="outline"
                          className="max-w-full whitespace-normal rounded-full border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] px-3 py-1.5 text-xs leading-5 text-foreground/80"
                        >
                          {item}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              </SurfaceInset>
            ))}
          </div>
        ) : null}
      </KaiControlSurface>

    </AppPageShell>
  );
}
