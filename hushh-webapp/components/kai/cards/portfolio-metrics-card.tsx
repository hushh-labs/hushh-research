"use client";

import { useMemo } from "react";
import { BarChart3, Percent, DollarSign, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES
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

// =============================================================================
// SUB-COMPONENTS & HELPERS
// =============================================================================

const formatters = {
  currency: (val: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val),
  percent: (val: number) => `${val.toFixed(2)}%`
};

function MetricItem({ label, value, icon, color = "text-foreground" }: { label: string; value: string | number; icon: any; color?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon icon={icon} size="sm" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className={cn("text-lg font-bold", color)}>{value}</div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function PortfolioMetricsCard({ holdings, totalValue, className }: PortfolioMetricsCardProps) {

  const metrics = useMemo(() => {
    if (!holdings.length || totalValue <= 0) return null;

    // HHI Calculation
    const hhi = holdings.reduce((sum, h) => sum + Math.pow((h.market_value / totalValue) * 100, 2), 0);
    const score = Math.round(Math.max(0, Math.min(100, ((10000 - hhi) / (10000 - 10000 / holdings.length)) * 100)));

    // Yield Calculation
    const yieldData = holdings.reduce((acc, h) => {
      if (h.est_yield && h.est_yield > 0) {
        acc.sum += h.est_yield * h.market_value;
        acc.weight += h.market_value;
      }
      return acc;
    }, { sum: 0, weight: 0 });

    return {
      diversification: {
        score,
        label: score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Moderate" : score >= 20 ? "Low" : "Poor",
        color: score >= 80 ? "text-emerald-500" : score >= 60 ? "text-blue-500" : score >= 40 ? "text-amber-500" : "text-red-500"
      },
      avgYield: yieldData.weight > 0 ? yieldData.sum / yieldData.weight : null,
      costBasis: holdings.reduce((sum, h) => sum + (h.cost_basis || 0), 0),
      sectorCount: new Set(holdings.map(h => h.sector || h.asset_type || "Other")).size
    };
  }, [holdings, totalValue]);

  if (!metrics) return null;

  const { diversification, avgYield, costBasis, sectorCount } = metrics;

  return (
    <Card variant="none" effect="glass" showRipple={false} className={cn("w-full", className)}>
      <CardHeader className="pb-1 pt-3 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Icon icon={BarChart3} size="md" className="text-primary" />
          Metrics
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-4">
          <MetricItem
            label="Diversity"
            value={`${diversification.score} (${diversification.label})`}
            icon={Layers}
            color={diversification.color}
          />
          <MetricItem label="Sectors" value={sectorCount} icon={Layers} />
          {avgYield !== null && (
            <MetricItem label="Avg Yield" value={formatters.percent(avgYield)} icon={Percent} color="text-emerald-500" />
          )}
          <MetricItem label="Cost Basis" value={formatters.currency(costBasis)} icon={DollarSign} />
        </div>
      </CardContent>
    </Card>
  );
}

export default PortfolioMetricsCard;