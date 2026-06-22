"use client";

import {
  Activity,
  ChartColumnIncreasing,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import {
  marketCardClassName,
  marketInsetClassName,
} from "@/components/kai/shared/market-surface-theme";
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
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {metrics.map((metric) => {
        const actionable = Boolean(metric.detailPanel && onMetricSelect);

        const card = (
          <SurfaceCard
            key={metric.id || metric.label}
            accent="none"
            className={cn(
              "h-full",
              marketCardClassName,
              actionable && "shadow-[var(--app-card-shadow-standard)]"
            )}
          >
            <SurfaceCardContent className="flex h-full min-h-[124px] flex-col justify-between p-4 sm:min-h-[134px] sm:p-5">
              <div className="flex items-start gap-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      marketInsetClassName,
                      "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full sm:h-10 sm:w-10",
                      metric.tone === "positive" &&
                        "border-[#34c759]/25 bg-[#34c759]/12 text-[#248a3d] dark:text-[#30d158]",
                      metric.tone === "negative" &&
                        "border-[#ff3b30]/25 bg-[#ff3b30]/12 text-[#d70015] dark:text-[#ff453a]",
                      metric.tone === "warning" &&
                        "border-[#ff9500]/25 bg-[#ff9500]/14 text-[#a05a00] dark:text-[#ffd60a]",
                      metric.tone === "neutral" &&
                        "border-[#0071e3]/18 bg-[#0071e3]/10 text-[#0071e3] dark:text-[#0a84ff]"
                    )}
                  >
                    <Icon icon={metric.icon || FALLBACK_ICON[metric.tone]} size="sm" />
                  </span>
                  <div className="min-w-0">
                    <span className="text-xs font-medium leading-5 text-muted-foreground">
                      {metric.label}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-xl font-semibold leading-none tracking-tight text-foreground sm:text-2xl">
                  {metric.value}
                </p>
                <p
                  className={cn(
                    "text-xs font-medium",
                    metric.tone === "positive" && "text-[#248a3d] dark:text-[#30d158]",
                    metric.tone === "negative" && "text-[#d70015] dark:text-[#ff453a]",
                    metric.tone === "warning" && "text-[#a05a00] dark:text-[#ffd60a]",
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
