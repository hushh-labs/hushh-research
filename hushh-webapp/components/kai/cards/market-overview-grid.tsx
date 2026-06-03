"use client";

import { useMemo } from "react";
import {
  Activity,
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

// 1. Ensure interfaces are correctly defined
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
  statusTone?: "positive" | "negative" | "neutral" | "warning";
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

// 2. Define helper constant inside the file or import it
const FALLBACK_ICON: Record<MarketOverviewMetric["tone"], LucideIcon> = {
  positive: TrendingUp,
  negative: TrendingDown,
  neutral: ChartColumnIncreasing,
  warning: Activity,
};

export function MarketOverviewGrid({
  metrics = [],
  onMetricSelect,
  selectedId,
  isLoading = false,
}: {
  metrics?: MarketOverviewMetric[];
  onMetricSelect?: (metric: MarketOverviewMetric) => void;
  selectedId?: string;
  isLoading?: boolean;
}) {
  const renderedMetrics = useMemo(() => metrics, [metrics]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-32 rounded-2xl bg-muted/50" />
        ))}
      </div>
    );
  }

  if (!renderedMetrics.length) {
    return (
      <SurfaceCard>
        <SurfaceCardContent className="text-sm text-muted-foreground p-4">
          Market overview metrics are currently unavailable.
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
      {renderedMetrics.map((metric: MarketOverviewMetric) => {
        const id = metric.id || metric.label;
        const isActive = selectedId === id;
        const actionable = Boolean(metric.detailPanel && onMetricSelect);

        const cardContent = (
          <SurfaceCard
            className={cn(
              "h-full transition-all duration-200 border-2",
              marketCardClassName,
              isActive ? "border-primary/50 shadow-lg" : "border-transparent",
              actionable && !isActive && "hover:border-muted-foreground/20"
            )}
          >
            <SurfaceCardContent className="flex h-full flex-col justify-between p-3.5 sm:p-4">
              <div className="flex items-center gap-2 mb-2">
                 <span className={cn(
                    "inline-flex h-8 w-8 items-center justify-center rounded-xl border",
                    metric.tone === "positive" ? "bg-emerald-500/10 text-emerald-600" :
                    metric.tone === "negative" ? "bg-rose-500/10 text-rose-600" :
                    "bg-muted text-muted-foreground"
                 )}>
                   {/* Explicit check for icon */}
                   <Icon icon={metric.icon || FALLBACK_ICON[metric.tone]} size="sm" />
                 </span>
                 <span className="text-xs font-medium text-muted-foreground truncate">{metric.label}</span>
              </div>
              
              <div>
                <p className="text-lg font-bold tracking-tight text-foreground">{metric.value}</p>
                <p className={cn("text-xs font-medium", 
                  metric.tone === "positive" ? "text-emerald-600" : "text-rose-600"
                )}>{metric.delta}</p>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>
        );

        if (!actionable) return <div key={id}>{cardContent}</div>;

        return (
          <button
            key={id}
            type="button"
            onClick={() => onMetricSelect?.(metric)}
            aria-label={`Select ${metric.label}`}
            className="group relative isolate w-full rounded-[var(--app-card-radius-feature)] text-left outline-none focus-visible:ring-2 ring-primary ring-offset-2"
          >
            {cardContent}
            <MaterialRipple effect="fade" className="z-10" />
          </button>
        );
      })}
    </div>
  );
}