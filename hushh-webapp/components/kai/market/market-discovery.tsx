"use client";

import { ArrowUpRight, ExternalLink } from "lucide-react";

import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  surfaceInteractiveShellClassName,
} from "@/components/app-ui/surfaces";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { marketCardClassName } from "@/components/kai/shared/market-surface-theme";
import { Badge } from "@/components/ui/badge";
import {
  type KaiHomeInsightsV2,
  type KaiHomeNewsItem,
  type KaiHomeSignal,
} from "@/lib/services/api-service";
import { requestInternalAppNavigation, openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";

export type MarketEvidenceItem = {
  label: string;
  value: string;
  tone?: "neutral" | "warning";
};

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

function uniqueMarketEvidenceItems(items: Array<MarketEvidenceItem | null | undefined>): MarketEvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item): item is MarketEvidenceItem => {
    if (!item) return false;
    const value = item.value.trim();
    if (!value || isUnavailableText(value)) return false;
    const key = `${item.label}:${value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function visibleMarketSourceTags(tags: string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .filter((tag) => !/fallback|unavailable|cache|derived/i.test(tag))
    .filter((tag, index, arr) => arr.findIndex((candidate) => candidate.toLowerCase() === tag.toLowerCase()) === index);
}

function formatEvidenceTimestamp(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function confidenceEvidenceItem(value: number | null | undefined): MarketEvidenceItem | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return {
    label: "Confidence",
    value: `${pct}%`,
  };
}

export function signalEvidenceItems(signal: KaiHomeSignal | undefined): MarketEvidenceItem[] {
  if (!signal) return [];
  return uniqueMarketEvidenceItems([
    confidenceEvidenceItem(signal.confidence),
    ...visibleMarketSourceTags(signal.source_tags)
      .slice(0, 2)
      .map((tag) => ({
        label: "Source",
        value: tag,
      })),
    signal.degraded
      ? {
          label: "State",
          value: "Degraded feed",
          tone: "warning",
        }
      : null,
  ]);
}

function spotlightEvidenceItems(
  row: NonNullable<KaiHomeInsightsV2["spotlights"]>[number]
): MarketEvidenceItem[] {
  const asOf = formatEvidenceTimestamp(row.as_of);
  return uniqueMarketEvidenceItems([
    confidenceEvidenceItem(row.confidence),
    row.recommendation_source
      ? {
          label: "Recommendation",
          value: row.recommendation_source,
        }
      : null,
    row.headline_source
      ? {
          label: "Coverage",
          value: row.headline_source,
        }
      : null,
    ...visibleMarketSourceTags(row.source_tags)
      .slice(0, 2)
      .map((tag) => ({
        label: "Source",
        value: tag,
      })),
    asOf
      ? {
          label: "Quote as of",
          value: asOf,
        }
      : null,
    row.degraded
      ? {
          label: "State",
          value: "Degraded feed",
          tone: "warning",
        }
      : null,
  ]);
}

export function MarketEvidenceStrip({
  items,
  compact = false,
}: {
  items: MarketEvidenceItem[];
  compact?: boolean;
}) {
  if (!items.length) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap gap-2 rounded-[calc(var(--app-card-radius-compact)-4px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]",
        compact ? "px-2.5 py-2" : "px-3 py-2.5"
      )}
      aria-label="Evidence used for this market read"
    >
      {items.slice(0, compact ? 3 : 4).map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground",
            item.tone === "warning" && "text-amber-700 dark:text-amber-300"
          )}
        >
          <span className="shrink-0 font-semibold text-foreground/72">{item.label}</span>
          <span className="truncate">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

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

export function SpotlightFeatureTile({
  row,
}: {
  row: NonNullable<KaiHomeInsightsV2["spotlights"]>[number];
}) {
  const decision = toSpotlightDecision(row.recommendation);
  const primaryHref = toSafeHttpUrl(row.headline_url) || `/kai/analysis?symbol=${encodeURIComponent(row.symbol)}`;
  const summary = summarizeSpotlight(row);
  const context = spotlightContextLabel(row);
  const evidenceItems = spotlightEvidenceItems(row);
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
        requestInternalAppNavigation({ href: primaryHref, scroll: false });
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
              <p className="text-xs font-medium text-muted-foreground">
                {row.symbol} - {context}
              </p>
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
        <MarketEvidenceStrip items={evidenceItems} compact />
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

export function MarketHeadlinesRail({ rows }: { rows: KaiHomeNewsItem[] }) {
  if (!rows.length) {
    return (
      <SurfaceCard className={cn("h-full", marketCardClassName)}>
        <SurfaceCardContent className="flex h-full min-h-[240px] items-center justify-center p-5 text-sm text-muted-foreground">
          No recent market headlines are available right now.
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard className={cn("h-full overflow-hidden", marketCardClassName)}>
      <SurfaceCardContent className="flex h-full min-h-[240px] flex-col p-0">
        <SurfaceCardHeader className="gap-1 border-b border-[color:var(--app-card-border-standard)] [--surface-card-header-px:1rem] [--surface-card-header-pt:0.75rem] [--surface-card-header-pb:0.75rem]">
          <SurfaceCardDescription className="text-[10px] font-semibold uppercase tracking-[0.2em]">
            Latest coverage
          </SurfaceCardDescription>
          <SurfaceCardTitle className="text-[15px] font-semibold tracking-tight">
            Fast reads from the tape
          </SurfaceCardTitle>
        </SurfaceCardHeader>
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
