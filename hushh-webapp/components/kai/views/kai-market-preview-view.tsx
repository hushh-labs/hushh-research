"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bell,
  Blocks,
  ChartColumnIncreasing,
  ChevronRight,
  CirclePlus,
  Compass,
  Cpu,
  LineChart,
  Loader2,
  MessageCircle,
  Mic,
  Newspaper,
  Percent,
  Search,
  Sparkles,
  Store,
  TrendingDown,
  TrendingUp,
  UserRound,
  WalletCards,
  X,
  type LucideIcon,
  Zap,
} from "lucide-react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { ConnectPortfolioCta } from "@/components/kai/cards/connect-portfolio-cta";
import { PermissionGate } from "@/components/privacy/permission-gate/permission-gate";
import {
  type MarketOverviewDetailPanel,
  type MarketOverviewMetric,
} from "@/components/kai/cards/market-overview-grid";
import {
  kaiPreviewDockActiveItemClassName,
  kaiPreviewDockItemClassName,
  kaiPreviewDockSurfaceClassName,
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
  "[--one-bg:#ffffff] [--one-card:#ffffff] [--one-surface:#f2f2f7]",
  "[--one-hairline:rgba(0,0,0,0.08)] [--one-line:rgba(0,0,0,0.06)]",
  "[--one-fg:#1d1d1f] [--one-fg2:rgba(0,0,0,0.55)] [--one-fg3:rgba(0,0,0,0.42)]",
  "[--one-blue:#0071e3] [--one-link:#0066cc]",
  "[--one-up:#34c759] [--one-up-t:rgba(52,199,89,0.12)]",
  "[--one-down:#ff3b30] [--one-down-t:rgba(255,59,48,0.10)]",
  "[--one-indigo:#5856d6] [--one-indigo-t:rgba(88,86,214,0.12)]",
  "[--one-orange:#ff9500] [--one-orange-t:rgba(255,149,0,0.14)]",
  "[--one-teal:#30b0c7] [--one-teal-t:rgba(48,176,199,0.13)]",
  "[--one-glass-fill:linear-gradient(135deg,rgba(255,255,255,0.45),rgba(255,255,255,0.16))]",
  "[--one-glass-float:0_16px_38px_-20px_rgba(0,0,0,0.28),0_4px_12px_-8px_rgba(0,0,0,0.10)]",
  "[--one-gutter:clamp(18px,4vw,32px)]"
);

const oneMarketGlassClassName = cn(
  "relative bg-[image:var(--one-glass-fill)] backdrop-blur-[20px] backdrop-saturate-[200%]",
  "shadow-[var(--one-glass-float),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_1px_rgba(0,0,0,0.06)]",
  "ring-1 ring-white/55"
);

type OneMarketDisplayRow = {
  symbol: string;
  companyName: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
};

type OneMarketMoverTab = "gain" | "lose" | "active";
type OneMarketNewsTone = "yahoo" | "bud" | "kai" | "positive" | "negative" | "neutral";

const ONE_MARKET_FALLBACK_ROWS: OneMarketDisplayRow[] = [
  { symbol: "TSLA", companyName: "Tesla", price: 248.5, changePct: 5.2, volume: 198_700_000 },
  { symbol: "AAPL", companyName: "Apple", price: 189.2, changePct: 1.1, volume: 84_200_000 },
  { symbol: "NVDA", companyName: "NVIDIA", price: 121.4, changePct: -0.8, volume: 312_400_000 },
  { symbol: "AMZN", companyName: "Amazon", price: 238, changePct: 1.9, volume: 61_500_000 },
];

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
    .map((row) => ({
      symbol: normalizeMarketSymbol(row?.symbol),
      companyName: String(row?.company_name || row?.symbol || "Market name").trim(),
      price: typeof row?.price === "number" && Number.isFinite(row.price) ? row.price : null,
      changePct:
        typeof row?.change_pct === "number" && Number.isFinite(row.change_pct)
          ? row.change_pct
          : null,
      volume: typeof row?.volume === "number" && Number.isFinite(row.volume) ? row.volume : null,
    }))
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

function toMostBoughtRows(
  rows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): OneMarketDisplayRow[] {
  const displayRows = dedupeOneMarketRows([...toOneMarketRows(rows), ...ONE_MARKET_FALLBACK_ROWS]);
  const preferred = ["TSLA", "AAPL", "NVDA", "AMZN"];
  const ordered = preferred
    .map((symbol) => displayRows.find((row) => row.symbol === symbol))
    .filter((row): row is OneMarketDisplayRow => Boolean(row));
  const rest = displayRows.filter((row) => !preferred.includes(row.symbol));
  return [...ordered, ...rest].slice(0, 4);
}

function toMoverGroups(
  payload: KaiHomeInsightsV2 | null,
  mostBoughtRows: OneMarketDisplayRow[]
): Record<OneMarketMoverTab, OneMarketDisplayRow[]> {
  const gainers = dedupeOneMarketRows([
    ...toOneMarketRows(payload?.movers?.gainers),
    ...mostBoughtRows.filter((row) => Number(row.changePct || 0) > 0),
    ...ONE_MARKET_FALLBACK_ROWS.filter((row) => Number(row.changePct || 0) > 0),
  ]).slice(0, 4);
  const losers = dedupeOneMarketRows([
    ...toOneMarketRows(payload?.movers?.losers),
    ...mostBoughtRows.filter((row) => Number(row.changePct || 0) < 0),
    ...ONE_MARKET_FALLBACK_ROWS.filter((row) => Number(row.changePct || 0) < 0),
  ]).slice(0, 4);
  const active = dedupeOneMarketRows([
    ...toOneMarketRows(payload?.movers?.active),
    ...mostBoughtRows,
    ...ONE_MARKET_FALLBACK_ROWS,
  ])
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
  const convertedRows = overviewRows.map((row) => toIndexOverviewMetric(row, row.label)).slice(0, 4);
  return convertedRows.length ? convertedRows : fallbackMetrics.slice(0, 4);
}

function toKaiStripText(
  payload: KaiHomeInsightsV2 | null,
  rows: Array<KaiHomeWatchlistItem | KaiHomeRenaissanceItem>
): string {
  const signal = String(payload?.signals?.[0]?.summary || "").trim();
  if (signal) return signal;
  const lowerCount = rows.filter((row) => typeof row.change_pct === "number" && row.change_pct < 0).length;
  const sectorLeader = Array.isArray(payload?.sector_rotation)
    ? [...payload.sector_rotation]
        .filter((row) => typeof row?.change_pct === "number")
        .sort((left, right) => Number(right.change_pct || 0) - Number(left.change_pct || 0))[0]
    : null;
  if (sectorLeader?.sector) {
    return `${sectorLeader.sector} is leading the current tape. ${lowerCount} tracked names are in the red.`;
  }
  return `Markets are live. ${lowerCount} tracked names are in the red.`;
}

function openOneMarketHref(href: string) {
  if (/^https?:\/\//i.test(href)) {
    openExternalUrl(href);
    return;
  }
  requestInternalAppNavigation({ href, scroll: false });
}

function oneMarketNewsTone(row: KaiHomeNewsItem, index: number): OneMarketNewsTone {
  const symbol = normalizeMarketSymbol(row.symbol);
  const source = String(row.source_name || "").toLowerCase();
  const title = String(row.title || "").toLowerCase();
  const sentiment = String(row.sentiment_hint || "").toLowerCase();

  if (symbol === "YHOO" || source.includes("yahoo")) return "yahoo";
  if (symbol === "BUD" || title.includes("anheuser") || title.includes("busch")) return "bud";
  if (symbol === "KAI" || source.includes("kai")) return "kai";
  if (sentiment.includes("positive")) return "positive";
  if (sentiment.includes("negative")) return "negative";
  return index % 3 === 0 ? "kai" : "neutral";
}

function oneMarketNewsCoverClassName(row: KaiHomeNewsItem, index: number): string {
  const tone = oneMarketNewsTone(row, index);
  if (tone === "yahoo") return "bg-[#5f01d1]";
  if (tone === "bud") return "bg-[#c8102e]";
  if (tone === "positive") return "bg-[color:var(--one-up)]";
  if (tone === "negative") return "bg-[color:var(--one-down)]";
  if (tone === "neutral") return "bg-[#8e8e93]";
  return "bg-[color:var(--one-blue)]";
}

function oneMarketNewsContext(row: KaiHomeNewsItem): string {
  const symbol = normalizeMarketSymbol(row.symbol);
  const title = String(row.title || "").toLowerCase();
  const source = String(row.source_name || "").toLowerCase();
  const sentiment = String(row.sentiment_hint || "").toLowerCase();

  if (title.includes("data") || title.includes("ai") || title.includes("ibm")) {
    return "AI and data migration read - useful for cloud, software, and infrastructure exposure.";
  }
  if (symbol === "KAI" || source.includes("kai") || title.includes("portfolio")) {
    return "Portfolio lens - see which holdings need attention as the tape softens.";
  }
  if (symbol === "BUD" || title.includes("defensive") || title.includes("anheuser") || title.includes("busch")) {
    return "Defensive rotation read - check staples exposure and downside protection.";
  }
  if (symbol === "NVDA" || title.includes("chip") || title.includes("semiconductor")) {
    return "AI infrastructure read - watch chip leadership and concentration risk.";
  }
  if (symbol === "TSLA" || title.includes("tesla") || title.includes("ev")) {
    return "High-beta move - review entry discipline and position sizing.";
  }
  if (symbol === "AAPL" || title.includes("apple")) {
    return "Quality tech read - watch device demand, services, and cash-flow durability.";
  }
  if (symbol === "AMZN" || title.includes("amazon")) {
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

function OneMarketNewsGlyph({ row, index }: { row: KaiHomeNewsItem; index: number }) {
  const tone = oneMarketNewsTone(row, index);
  if (tone === "kai") {
    return <Sparkles className="h-9 w-9 drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]" />;
  }
  if (tone === "yahoo") return <>y!</>;
  if (tone === "bud") return <>B</>;
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
  const baseClassName =
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[color:var(--one-surface)] text-[color:var(--one-fg)]";
  if (normalized === "TSLA") {
    return (
      <span className={cn(baseClassName, "bg-[#e82127] text-white", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.188.354-4.335 1.792 0 0-2.146-.795-3.229-2.43C5.28 2.431 9.525 2.34 9.525 2.34L12 5.362l-.004.002H12v-.002zm0-3.899c3.415-.03 7.326.528 11.328 2.28.535-.968.672-1.395.672-1.395C19.625.612 15.528.015 12 0 8.472.015 4.375.61 0 2.349c0 0 .195.525.672 1.396C4.674 1.989 8.585 1.435 12 1.46v.003z" />
        </svg>
      </span>
    );
  }
  if (normalized === "AAPL") {
    return (
      <span className={cn(baseClassName, "border border-[color:var(--one-hairline)] bg-white text-[#111111]", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
        </svg>
      </span>
    );
  }
  if (normalized === "NVDA") {
    return (
      <span className={cn(baseClassName, "bg-[#76b900] text-white", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" />
        </svg>
      </span>
    );
  }
  if (normalized === "META") {
    return (
      <span className={cn(baseClassName, "border border-[color:var(--one-hairline)] bg-white text-[#0866ff]", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
          <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
        </svg>
      </span>
    );
  }
  if (normalized === "GOOGL" || normalized === "GOOG") {
    return (
      <span className={cn(baseClassName, "border border-[color:var(--one-hairline)] bg-white", className)} aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-[58%] w-[58%]">
          <path fill="#4285F4" d="M23.06 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h6.2a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.18-2 3.44-4.96 3.44-8.39Z" />
          <path fill="#34A853" d="M12 24c3.1 0 5.7-1.03 7.6-2.79l-3.72-2.9c-1.03.7-2.35 1.1-3.88 1.1-2.98 0-5.5-2.01-6.4-4.72H1.76v2.99A11.5 11.5 0 0 0 12 24Z" />
          <path fill="#FBBC05" d="M5.6 14.69a6.9 6.9 0 0 1 0-4.38v-2.99H1.76a11.5 11.5 0 0 0 0 10.36l3.84-2.99Z" />
          <path fill="#EA4335" d="M12 4.75c1.68 0 3.2.58 4.39 1.72l3.29-3.29C17.7 1.27 15.1.25 12 .25 7.49.25 3.6 2.84 1.76 6.62l3.84 2.99C6.5 6.76 9.02 4.75 12 4.75Z" />
        </svg>
      </span>
    );
  }
  if (normalized === "AMZN") {
    return (
      <span className={cn(baseClassName, "relative bg-[#232f3e] text-white", className)} aria-hidden="true">
        <span className="text-[13px] font-bold leading-none">a</span>
        <svg viewBox="0 0 24 8" className="absolute bottom-[5px] left-[21%] h-[7px] w-[58%] text-[#ff9900]">
          <path d="M2 2c5.5 4 14.5 4 20-.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M19.3 1l3.2-.4-1.1 2.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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

function IndexSparkline({ tone }: { tone: MarketOverviewMetric["tone"] }) {
  const negative = tone === "negative";
  const stroke = negative ? "var(--one-down)" : "var(--one-up)";
  const path = negative
    ? "M0 4 L14 7 L28 5 L42 10 L56 9 L70 13 L84 12 L100 17"
    : "M0 16 L14 13 L28 14 L42 10 L56 11 L70 7 L84 8 L100 4";
  return (
    <svg
      className="mt-2 block h-5 w-full opacity-90"
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
          <div className="truncate text-[12px] font-medium text-[color:var(--one-fg2)]">
            {metric.label}
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
          <IndexSparkline tone={metric.tone} />
        </button>
      ))}
    </div>
  );
}

function OneMarketStockCard({ row }: { row: OneMarketDisplayRow }) {
  const tone = oneMarketTone(row.changePct);
  return (
    <button
      type="button"
      onClick={() => openOneMarketHref(`/kai/analysis?symbol=${encodeURIComponent(row.symbol)}`)}
      className="min-h-[124px] rounded-[18px] bg-[color:var(--one-card)] px-4 py-[15px] text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-14px_rgba(0,0,0,0.16)] transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_20px_34px_-18px_rgba(0,0,0,0.22)] active:scale-[0.985]"
    >
      <BrandLogo symbol={row.symbol} className="h-8 w-8 rounded-[9px]" />
      <div className="mt-[9px] truncate text-[13px] font-semibold text-[color:var(--one-fg)]">
        {row.companyName}
      </div>
      <div className="mt-[7px] flex items-baseline gap-[7px]">
        <span className="text-[14px] font-semibold tabular-nums text-[color:var(--one-fg)]">
          {formatOneMarketPrice(row.price)}
        </span>
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
      </div>
    </button>
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
      onClick={() => openOneMarketHref(`/kai/analysis?symbol=${encodeURIComponent(row.symbol)}`)}
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

function OneMarketNewsCards({ rows }: { rows: KaiHomeNewsItem[] }) {
  const fallbackRows = rows.length
    ? rows
    : [
        {
          symbol: "KAI",
          title: "Defensives lead as indices slip. What it means for your portfolio",
          url: "/kai/analysis",
          published_at: new Date().toISOString(),
          source_name: "Kai Wrap",
          provider: "local",
          degraded: false,
        },
      ];
  return (
    <div className="-mx-[var(--one-gutter)] flex gap-3 overflow-x-auto px-[var(--one-gutter)] pb-1 pt-0.5 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:px-0 [&::-webkit-scrollbar]:hidden">
      {fallbackRows.slice(0, 4).map((row, index) => (
        <button
          key={`${row.symbol}-${index}-${row.url}`}
          type="button"
          onClick={() => openOneMarketHref(row.url)}
          className="group/news flex w-[274px] shrink-0 flex-col overflow-hidden rounded-[18px] bg-[color:var(--one-card)] text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.22)] transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_20px_34px_-18px_rgba(0,0,0,0.26)] active:scale-[0.985] sm:w-full"
        >
          <div
            className={cn(
              "relative grid h-[116px] place-items-center overflow-hidden",
              "after:pointer-events-none after:absolute after:inset-y-0 after:-left-[80%] after:w-[60%] after:skew-x-[-20deg] after:bg-[linear-gradient(105deg,transparent,rgba(255,255,255,0.44),transparent)] after:transition-[left] after:duration-700 group-hover/news:after:left-[130%]",
              oneMarketNewsCoverClassName(row, index)
            )}
          >
            <span className="absolute left-3 top-3 rounded-full bg-white/18 px-2 py-1 text-[10px] font-semibold uppercase tracking-normal text-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.20)] backdrop-blur-md">
              {normalizeMarketSymbol(row.symbol) || "NEWS"}
            </span>
            <span className="relative text-[36px] font-semibold leading-none tracking-normal text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
              <OneMarketNewsGlyph row={row} index={index} />
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
          </div>
          <div className="flex flex-1 flex-col px-[13px] pb-[13px] pt-[11px]">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-[color:var(--one-fg3)]">
              <span className="min-w-0 truncate">{row.source_name || "Market news"}</span>
              <span className="h-0.5 w-0.5 rounded-full bg-[color:var(--one-fg3)]" />
              <span className="shrink-0">{formatHeadlinePublished(row.published_at)}</span>
            </div>
            <div className="line-clamp-2 text-[13.5px] font-semibold leading-[1.35] text-[color:var(--one-fg)]">
              {row.title}
            </div>
            <p className="mt-2 line-clamp-2 text-[12px] leading-[1.38] text-[color:var(--one-fg2)]">
              {oneMarketNewsContext(row)}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate rounded-full bg-[color:var(--one-surface)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--one-fg2)]">
                {normalizeMarketSymbol(row.symbol) || "MARKET"}
              </span>
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
                  item.tone === "blue" && "bg-[#0071e3]/10 text-[color:var(--one-link)]"
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

function OneMarketKaiSheet({
  open,
  onClose,
  message,
}: {
  open: boolean;
  onClose: () => void;
  message: string;
}) {
  return (
    <section
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[min(92vh,760px)] max-w-[720px] flex-col rounded-t-[28px] bg-white/95 shadow-[0_-18px_50px_-20px_rgba(0,0,0,0.40)] backdrop-blur-[20px] transition-transform duration-300",
        open ? "translate-y-0" : "translate-y-[105%]"
      )}
      aria-label="Kai agent"
      aria-hidden={!open}
    >
      <div className="mx-auto mt-2.5 h-[5px] w-9 rounded-full bg-[color:var(--one-fg3)] opacity-35" />
      <header className="flex items-center gap-3 border-b border-[color:var(--one-line)] px-[18px] pb-3 pt-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.30)]">
          <MessageCircle className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-[17px] font-semibold text-[color:var(--one-fg)]">Kai</b>
          <span className="block text-[12px] text-[color:var(--one-fg3)]">Personal intelligence · works only for you</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg2)]"
          aria-label="Close Kai"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-[84%] rounded-[18px] rounded-bl-md bg-[color:var(--one-surface)] px-3.5 py-2.5 text-[14px] leading-relaxed text-[color:var(--one-fg)]">
          {message}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-2">
        {["Review my holdings", "What's moving today?", "Run a risk check"].map((label) => (
          <button
            key={label}
            type="button"
            className="rounded-full bg-[color:var(--one-surface)] px-3 py-2 text-[12px] font-semibold text-[color:var(--one-fg)]"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-[color:var(--one-line)] px-3.5 pb-[calc(14px+env(safe-area-inset-bottom))] pt-2.5">
        <div className="flex h-10 min-w-0 flex-1 items-center rounded-full bg-[color:var(--one-surface)] px-3.5">
          <input
            placeholder="Message Kai..."
            className="w-full bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
          />
        </div>
        <button
          type="button"
          className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white"
          aria-label="Speak to Kai"
        >
          <Mic className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}

function OneMarketDock({
  searchOpen,
  searchQuery,
  onSearchOpen,
  onSearchClose,
  onSearchQueryChange,
  onSearchSubmit,
  onKaiOpen,
}: {
  searchOpen: boolean;
  searchQuery: string;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  onSearchQueryChange: (value: string) => void;
  onSearchSubmit: () => void;
  onKaiOpen: () => void;
}) {
  const items: Array<{ label: string; href: string; icon: LucideIcon; active?: boolean }> = [
    { label: "Market", href: "/kai", icon: Store, active: true },
    { label: "Portfolio", href: "/kai/portfolio", icon: WalletCards },
    { label: "Analysis", href: "/kai/analysis", icon: LineChart },
    { label: "Connect", href: "/kai?preview=connect", icon: Compass },
    { label: "Profile", href: "/profile", icon: UserRound },
  ];
  const submitDockSearch = () => {
    const hasQuery = searchQuery.trim().length > 0;
    onSearchSubmit();
    if (hasQuery) {
      onSearchClose();
    }
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] px-4 pb-[calc(10px+env(safe-area-inset-bottom))] sm:px-6 before:pointer-events-none before:absolute before:inset-x-[-18px] before:bottom-[-10px] before:h-[126px] before:bg-[linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,0.88)_34%,rgba(255,255,255,0.98))] before:backdrop-blur-[8px] [&>*]:relative [&>*]:z-[1]">
      <div className="relative flex items-end gap-2.5 sm:gap-3">
        {searchOpen ? (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submitDockSearch();
              }}
              className={cn(
                kaiPreviewDockSurfaceClassName,
                "pointer-events-auto flex h-[50px] min-w-0 flex-1 items-center gap-[9px] rounded-full px-[15px] pr-2"
              )}
            >
              <Search className="h-5 w-5 shrink-0 text-[color:var(--one-fg3)]" />
              <input
                placeholder="Search"
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
              />
              <button
                type="button"
                onClick={submitDockSearch}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white transition-transform active:scale-[0.92]"
                aria-label="Voice search"
              >
                <Mic className="h-4 w-4" />
              </button>
            </form>
            <button
              type="button"
              onClick={onSearchClose}
              className="pointer-events-auto flex h-[50px] shrink-0 items-center justify-center rounded-full px-1.5 text-[14px] font-semibold text-[color:var(--one-link)]"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <nav
              className={cn(
                kaiPreviewDockSurfaceClassName,
                "pointer-events-auto grid h-[58px] min-w-0 flex-1 grid-cols-5 content-center rounded-full px-1.5"
              )}
            >
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => openOneMarketHref(item.href)}
                    className={cn(
                      kaiPreviewDockItemClassName,
                      item.active && kaiPreviewDockActiveItemClassName
                    )}
                  >
                    <Icon className="h-[21px] w-[21px]" strokeWidth={1.8} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <button
              type="button"
              onClick={onKaiOpen}
              className={cn(kaiPreviewDockSurfaceClassName, "pointer-events-auto absolute bottom-[72px] right-1 grid h-[50px] w-[50px] place-items-center rounded-full")}
              aria-label="Talk to Kai"
            >
              <span className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-[color:var(--one-blue)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
                <CirclePlus className="h-[15px] w-[15px]" strokeWidth={2} />
              </span>
            </button>
            <div className="pointer-events-auto flex shrink-0">
              <button
                type="button"
                onClick={onSearchOpen}
                className={cn(kaiPreviewDockSurfaceClassName, "grid h-[58px] w-[58px] place-items-center rounded-full text-[color:var(--one-fg2)] transition-transform active:scale-[0.9]")}
                aria-label="Search"
              >
                <Search className="h-5 w-5" strokeWidth={2.2} />
              </button>
            </div>
          </>
        )}
      </div>
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
  } = useKaiMarketHomeController();
  const [retainedPayload, setRetainedPayload] = useState<KaiHomeInsightsV2 | null>(payload);
  const usingLocalPreviewFallback = Boolean(localPreviewPayload && !payload);
  const displayPayload = payload ?? localPreviewPayload;
  const displayLoading = usingLocalPreviewFallback ? false : loading;
  const displayRefreshing = usingLocalPreviewFallback ? false : refreshing;
  const displayError = usingLocalPreviewFallback ? null : error;
  const [selectedOverviewMetricId, setSelectedOverviewMetricId] = useState<string | null>(null);
  const [moverTab, setMoverTab] = useState<OneMarketMoverTab>("gain");
  const [topbarVisible, setTopbarVisible] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [kaiSheetOpen, setKaiSheetOpen] = useState(false);
  const [dockSearchOpen, setDockSearchOpen] = useState(false);
  const [marketSearchQuery, setMarketSearchQuery] = useState("");
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
  const mostBoughtRows = useMemo(() => toMostBoughtRows(pickRows), [pickRows]);
  const moverGroups = useMemo(
    () => toMoverGroups(effectivePayload, mostBoughtRows),
    [effectivePayload, mostBoughtRows]
  );
  const kaiStripText = useMemo(
    () => toKaiStripText(effectivePayload, pickRows),
    [effectivePayload, pickRows]
  );
  const effectiveNewsTape = effectivePayload?.news_tape;
  const marketNewsRows = useMemo(
    () => (Array.isArray(effectiveNewsTape) ? effectiveNewsTape : []),
    [effectiveNewsTape]
  );
  const shellOverlayOpen = notificationsOpen || kaiSheetOpen;
  const closeShellOverlays = useCallback(() => {
    setNotificationsOpen(false);
    setKaiSheetOpen(false);
  }, []);

  useEffect(() => {
    const updateTopbar = () => {
      setTopbarVisible(window.scrollY > 64);
    };
    updateTopbar();
    window.addEventListener("scroll", updateTopbar, { passive: true });
    return () => {
      window.removeEventListener("scroll", updateTopbar);
    };
  }, []);

  const handleMarketSearchSubmit = useCallback(() => {
    const query = marketSearchQuery.trim();
    if (!query) {
      setDockSearchOpen(true);
      return;
    }
    const normalizedQuery = query.length <= 6 ? query.toUpperCase() : query;
    openOneMarketHref(`/kai/analysis?symbol=${encodeURIComponent(normalizedQuery)}`);
  }, [marketSearchQuery]);

  return (
    <AppPageShell
      as="div"
      width="reading"
      className={oneMarketRootClassName}
      data-one-market-preview={localPreviewPayload ? "true" : undefined}
    >
      {localPreviewPayload ? (
        <style>
          {`
            html:has([data-one-market-preview="true"]),
            body {
              background: #ffffff !important;
            }

            body:has([data-one-market-preview="true"]) main,
            body:has([data-one-market-preview="true"]) [data-top-content-anchor="true"],
            body:has([data-one-market-preview="true"]) [class*="overflow-y-auto"][class*="touch-pan-y"] {
              background: #ffffff !important;
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
        className="pointer-events-none absolute inset-0 -z-20 bg-white"
      />
      <div
        className={cn(
          oneMarketGlassClassName,
          "pointer-events-none fixed inset-x-0 top-0 z-30 mx-auto flex h-[50px] max-w-[1080px] items-center justify-center border-b border-[color:var(--one-hairline)] bg-white/85 text-[17px] font-semibold text-[color:var(--one-fg)] transition duration-300",
          topbarVisible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
        )}
      >
        Market
      </div>

      <div className="flex-1 pb-[calc(148px+env(safe-area-inset-bottom))] pt-0">
        <header className="mx-auto w-full max-w-[1080px] px-[var(--one-gutter)] pt-4">
          <div className="flex items-start justify-between">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className={cn("inline-flex items-center gap-[7px] text-[color:var(--one-up)]", kaiPreviewEyebrowClassName)}>
                <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--one-up)]" />
                {marketStatus?.label?.toLowerCase().includes("open") ? "Markets open" : "Live market"}
              </span>
              <div className={kaiPreviewPageTitleClassName} role="heading" aria-level={1}>
                Market
              </div>
              <p className="max-w-[32ch] text-[14px] leading-snug text-[color:var(--one-fg2)]">
                Track the market and your watchlist.
              </p>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setNotificationsOpen(true)}
                className="relative grid h-9 w-9 place-items-center rounded-full bg-[color:var(--one-surface)] text-[color:var(--one-fg)] transition-transform active:scale-90"
                aria-label="Notifications"
              >
                <span className="absolute right-2 top-[7px] h-1.5 w-1.5 rounded-full bg-[color:var(--one-down)] shadow-[0_0_0_2px_var(--one-surface)]" />
                <Bell className="h-[17px] w-[17px]" />
              </button>
            </div>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleMarketSearchSubmit();
            }}
            className="mt-[18px] flex h-[46px] items-center gap-2.5 rounded-xl bg-[color:var(--one-surface)] px-3.5"
          >
            <Search className="h-[17px] w-[17px] shrink-0 text-[color:var(--one-fg3)]" />
            <input
              type="text"
              placeholder="Search stocks, ETFs, indices"
              value={marketSearchQuery}
              onChange={(event) => setMarketSearchQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--one-fg)] outline-none placeholder:text-[color:var(--one-fg3)]"
            />
          </form>
        </header>

        <OneMarketIndexStrip
          metrics={indexStripItems}
          onMetricSelect={(metric) => setSelectedOverviewMetricId(metric.id || metric.label)}
        />

          <div className="mx-auto w-full max-w-[1080px] px-[var(--one-gutter)]">
          <button
            type="button"
            onClick={() => setKaiSheetOpen(true)}
            className={cn(oneMarketGlassClassName, "mt-[22px] flex w-full items-center gap-[11px] rounded-2xl px-4 py-3.5 text-left transition-transform active:scale-[0.99]")}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--one-blue)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.30)]">
              <MessageCircle className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-[color:var(--one-fg)]">
              <b className="font-semibold">Kai:</b> {kaiStripText}
            </span>
            <ChevronRight className="h-[15px] w-[15px] shrink-0 text-[color:var(--one-fg3)]" />
          </button>
        </div>

        {displayLoading && !hasPayload ? (
          <div className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
            <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-[18px] bg-[color:var(--one-card)] p-5 text-center text-[14px] text-[color:var(--one-fg2)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <p>Loading your market view.</p>
            </div>
          </div>
        ) : null}

        {displayError ? (
          <div className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
            <div className="space-y-3 rounded-[18px] bg-[color:var(--one-card)] p-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-16px_rgba(0,0,0,0.16)]">
              <div className="flex items-center gap-2 text-[color:var(--one-down)]">
                <AlertTriangle className="h-4 w-4" />
                <p className="text-[14px] font-semibold">
                  {hasPayload ? "Failed to refresh market home" : "Failed to load market home"}
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

        {hasPayload ? (
          <>
            <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <OneMarketSectionHeader title="Most bought on One" icon={Blocks} tone="indigo" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {mostBoughtRows.map((row) => (
                  <OneMarketStockCard key={row.symbol} row={row} />
                ))}
              </div>
            </section>

            <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <OneMarketSectionHeader title="Top movers" icon={ChartColumnIncreasing} tone="orange" actionLabel="See all" actionHref="/kai/analysis?view=movers" />
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
                {moverGroups[moverTab].map((row) => (
                  <OneMarketMoverRow key={`${moverTab}-${row.symbol}`} row={row} tab={moverTab} />
                ))}
              </div>
            </section>

            <section className="mx-auto mt-9 w-full max-w-[1080px] px-[var(--one-gutter)]">
              <OneMarketSectionHeader title="Market news" icon={Newspaper} tone="teal" actionLabel="More" actionHref="/kai/analysis" />
              <OneMarketNewsCards rows={marketNewsRows} />
            </section>

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

      <OneMarketDock
        searchOpen={dockSearchOpen}
        searchQuery={marketSearchQuery}
        onSearchOpen={() => setDockSearchOpen(true)}
        onSearchClose={() => setDockSearchOpen(false)}
        onSearchQueryChange={setMarketSearchQuery}
        onSearchSubmit={handleMarketSearchSubmit}
        onKaiOpen={() => setKaiSheetOpen(true)}
      />

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
      <OneMarketKaiSheet
        open={kaiSheetOpen}
        onClose={() => setKaiSheetOpen(false)}
        message={kaiStripText}
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
