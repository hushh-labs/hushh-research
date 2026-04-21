"use client";

import {
  Activity,
  ArrowUpRight,
  ChartColumnIncreasing,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { marketCardClassName } from "@/components/kai/shared/market-surface-theme";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

export interface MarketOverviewDetailSection {
  title: string;
  lines: string[];
  items?: string[];
}

export interface MarketOverviewDetailPanel {
  eyebrow?: string;
  title: string;
  summary?: string;
  value?: string;
  delta?: string;
  statusLabel?: string;
  statusTone?: MarketOverviewMetric["tone"];
  sections?: MarketOverviewDetailSection[];
}

export interface MarketOverviewMetric {
  id?: string;
  label: string;
  value: string;
  delta: string;
  detail?: string;
  detailLines?: string[];
  detailPanel?: MarketOverviewDetailPanel;
  tone: "positive" | "negative" | "neutral" | "warning";
  icon: LucideIcon;
}

const FALLBACK_ICON: Record<MarketOverviewMetric["tone"], LucideIcon> = {
  positive: TrendingUp,
  negative: TrendingDown,
  neutral: ChartColumnIncreasing,
  warning: Activity,
};

const MARKET_ACTION_CARD_CLASSNAME =
  "shadow-[var(--app-card-shadow-standard)]";

export function MarketOverviewGrid({
  metrics = [],
  onMetricSelect,
}: {
  metrics?: MarketOverviewMetric[];
  onMetricSelect?: (metric: MarketOverviewMetric) => void;
}) {
  if (!metrics.length) {
    return (
      <SurfaceCard tone="warning">
        <SurfaceCardContent className="text-sm text-muted-foreground">
          Market overview metrics are not available at the moment.
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => {
        const actionable = Boolean(metric.detailPanel && onMetricSelect);

        const card = (
          <SurfaceCard
            accent="none"
            className={cn(
              "h-full",
              marketCardClassName,
              actionable && MARKET_ACTION_CARD_CLASSNAME,
              actionable &&
                "transition-[transform,box-shadow,background-color] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:bg-[color:var(--app-card-surface-hero)] group-hover:shadow-[var(--app-card-shadow-feature)]"
            )}
          >
            <SurfaceCardContent className="flex h-full min-h-[96px] flex-col justify-between p-3.5 sm:min-h-[104px] sm:p-4">
              <div className="flex items-start gap-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border shadow-sm sm:h-9 sm:w-9",
                      metric.tone === "positive" &&
                        "border-emerald-500/18 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      metric.tone === "negative" &&
                        "border-rose-500/18 bg-rose-500/10 text-rose-700 dark:text-rose-300",
                      metric.tone === "warning" &&
                        "border-amber-500/18 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                      metric.tone === "neutral" &&
                        "border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] text-muted-foreground"
                    )}
                  >
                    <Icon icon={metric.icon || FALLBACK_ICON[metric.tone]} size="sm" />
                  </span>
                  <div className="min-w-0">
                    <span className="text-xs font-semibold leading-5 text-muted-foreground">
                      {metric.label}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-base font-semibold leading-none tracking-tight text-foreground sm:text-lg">
                  {metric.value}
                </p>
                <p
                  className={cn(
                    "text-xs font-medium",
                    metric.tone === "positive" && "text-emerald-600 dark:text-emerald-400",
                    metric.tone === "negative" && "text-rose-600 dark:text-rose-400",
                    metric.tone === "warning" && "text-orange-600 dark:text-orange-400",
                    metric.tone === "neutral" && "text-muted-foreground"
                  )}
                >
                  {metric.delta}
                </p>
                {Array.isArray(metric.detailLines) && metric.detailLines.length ? (
                  <div className="space-y-1 pt-0.5">
                    {metric.detailLines.slice(0, 2).map((line) => (
                      <p key={line} className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                        {line}
                      </p>
                    ))}
                  </div>
                ) : metric.detail ? (
                  <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {metric.detail}
                  </p>
                ) : null}
              </div>
              {actionable ? (
                <div className="flex items-center justify-between border-t border-[color:var(--app-card-border-standard)]/80 pt-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/72">
                    View detail
                  </p>
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-foreground/72 shadow-[var(--shadow-xs)] transition-colors group-hover:text-foreground">
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              ) : (
                <div className="h-[38px]" />
              )}
            </SurfaceCardContent>
          </SurfaceCard>
        );

        if (!actionable) {
          return card;
        }

        return (
          <button
            key={metric.id || metric.label}
            type="button"
            onClick={() => onMetricSelect?.(metric)}
            className="group relative isolate w-full rounded-[var(--app-card-radius-feature)] text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2"
          >
            {card}
            <MaterialRipple variant="none" effect="fade" className="z-10" />
          </button>
        );
      })}
    </div>
  );
}
