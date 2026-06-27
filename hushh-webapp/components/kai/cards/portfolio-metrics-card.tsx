"use client";

import { useMemo } from "react";
import { BarChart3, Percent, DollarSign, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES & CONFIG
// =============================================================================

interface Holding {
  symbol: string;
  name: string;
  market_value: number;
  cost_basis?: number;
  est_yield?: number;
  sector?: string;
  asset_type?: string;
}

interface PortfolioMetricsCardProps {
  holdings: Holding[];
  totalValue: number;
  className?: string;
}

const DIVERSITY_STATUS = {
  EXCELLENT: { label: "Excellent", color: "text-emerald-500", bg: "bg-emerald-500/10" },
  GOOD: { label: "Good", color: "text-blue-500", bg: "bg-blue-500/10" },
  MODERATE: { label: "Moderate", color: "text-amber-500", bg: "bg-amber-500/10" },
  POOR: { label: "Low/Poor", color: "text-red-500", bg: "bg-red-500/10" },
};

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function MetricItem({ label, value, icon, color = "text-foreground", ariaLabel }: { label: string; value: string | number; icon: any; color?: string; ariaLabel?: string }) {
  return (
    <div className="space-y-0.5" aria-label={ariaLabel || label}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        <Icon icon={icon} size="xs" />
        <span>{label}</span>
      </div>
      <div className={cn("text-sm font-bold", color)}>{value}</div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function PortfolioMetricsCard({ holdings, totalValue, className }: PortfolioMetricsCardProps) {
  const metrics = useMemo(() => {
    if (!holdings.length || totalValue <= 0) return null;

    const hhi = holdings.reduce((sum, h) => sum + Math.pow((h.market_value / totalValue) * 100, 2), 0);
    const score = Math.max(0, Math.min(100, Math.round(((10000 - hhi) / (10000 - (10000 / holdings.length))) * 100)));

    const status = score >= 80 ? DIVERSITY_STATUS.EXCELLENT : score >= 60 ? DIVERSITY_STATUS.GOOD : score >= 40 ? DIVERSITY_STATUS.MODERATE : DIVERSITY_STATUS.POOR;

    const yieldSum = holdings.reduce((acc, h) => acc + ((h.est_yield || 0) * h.market_value), 0);

    return {
      diversity: { score, status },
      avgYield: yieldSum / totalValue,
      costBasis: holdings.reduce((sum, h) => sum + (h.cost_basis || 0), 0),
      sectorCount: new Set(holdings.map(h => h.sector || h.asset_type || "Other")).size
    };
  }, [holdings, totalValue]);

  if (!metrics) return null;

  return (
    <Card variant="none" effect="glass" className={cn("w-full border-border/50", className)}>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-xs font-bold flex items-center gap-2 text-muted-foreground uppercase tracking-widest">
          <Icon icon={BarChart3} size="xs" />
          Portfolio Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 grid grid-cols-2 gap-y-4 gap-x-2">
        <MetricItem
          label="Diversity Score"
          value={metrics.diversity.score}
          icon={Layers}
          color={metrics.diversity.status.color}
        />
        <MetricItem label="Unique Sectors" value={metrics.sectorCount} icon={Layers} />
        <MetricItem label="Avg Portfolio Yield" value={`${(metrics.avgYield * 100).toFixed(2)}%`} icon={Percent} color="text-emerald-500" />
        <MetricItem label="Total Cost Basis" value={`$${metrics.costBasis.toLocaleString()}`} icon={DollarSign} />
      </CardContent>
    </Card>
  );
}