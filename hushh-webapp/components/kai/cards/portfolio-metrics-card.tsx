// components/kai/cards/portfolio-metrics-card.tsx

/**
 * Portfolio Metrics Card
 * 
 * Features:
 * - Diversification score based on concentration
 * - Average yield from holdings
 * - Weighted average cost basis
 * - Number of sectors represented
 */

"use client";

import { useMemo } from "react";
import { BarChart3, Percent, DollarSign, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

export function PortfolioMetricsCard({
  holdings,
  totalValue,
  className,
}: PortfolioMetricsCardProps) {
  // Calculate diversification score (0-100)
  // Based on Herfindahl-Hirschman Index (HHI)
  const diversificationScore = useMemo(() => {
    if (holdings.length === 0 || totalValue === 0) return 0;
    
    // Calculate HHI (sum of squared market share percentages)
    const hhi = holdings.reduce((sum, h) => {
      const share = (h.market_value / totalValue) * 100;
      return sum + share * share;
    }, 0);
    
    // Convert HHI to a 0-100 score (lower HHI = more diversified)
    // HHI ranges from 10000/n (perfectly diversified) to 10000 (single holding)
    // We normalize: 100 = perfectly diversified, 0 = single holding
    const minHHI = 10000 / Math.max(holdings.length, 1);
    const maxHHI = 10000;
    const score = Math.max(0, Math.min(100, ((maxHHI - hhi) / (maxHHI - minHHI)) * 100));
    
    return Math.round(score);
  }, [holdings, totalValue]);

  // Calculate average yield
  const avgYield = useMemo(() => {
    const holdingsWithYield = holdings.filter((h) => h.est_yield !== undefined && h.est_yield > 0);
    if (holdingsWithYield.length === 0) return null;
    
    // Weighted average by market value
    const totalWeight = holdingsWithYield.reduce((sum, h) => sum + h.market_value, 0);
    if (totalWeight === 0) return null;
    
    const weightedYield = holdingsWithYield.reduce(
      (sum, h) => sum + (h.est_yield || 0) * (h.market_value / totalWeight),
      0
    );
    
    return weightedYield;
  }, [holdings]);

  // Calculate weighted average cost basis
  const weightedCostBasis = useMemo(() => {
    const holdingsWithCost = holdings.filter((h) => h.cost_basis !== undefined && h.cost_basis > 0);
    if (holdingsWithCost.length === 0) return null;
    
    const totalCost = holdingsWithCost.reduce((sum, h) => sum + (h.cost_basis || 0), 0);
    return totalCost;
  }, [holdings]);

  // Count unique sectors
  const sectorCount = useMemo(() => {
    const sectors = new Set<string>();
    holdings.forEach((h) => {
      if (h.sector) sectors.add(h.sector);
      else if (h.asset_type) sectors.add(h.asset_type);
    });
    return sectors.size;
  }, [holdings]);

  // Get diversification label
  const diversificationLabel = useMemo(() => {
    if (diversificationScore >= 80) return "Excellent";
    if (diversificationScore >= 60) return "Good";
    if (diversificationScore >= 40) return "Moderate";
    if (diversificationScore >= 20) return "Low";
    return "Poor";
  }, [diversificationScore]);

  // Get diversification color
  const diversificationColor = useMemo(() => {
    if (diversificationScore >= 80) return "text-emerald-500";
    if (diversificationScore >= 60) return "text-blue-500";
    if (diversificationScore >= 40) return "text-amber-500";
    return "text-red-500";
  }, [diversificationScore]);

  if (holdings.length === 0) {
    return null;
  }

  return (
    <Card variant="none" effect="glass" showRipple={false} className={className}>
      <CardHeader className="pb-1 pt-3 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Icon icon={BarChart3} size="md" className="text-primary" aria-hidden="true" />
          Metrics
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          {/* Diversification Score */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon icon={Layers} size="md" aria-hidden="true" />
              <span>Diversity</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className={cn("text-lg font-bold", diversificationColor)}>
                {diversificationScore}
              </span>
              <span className={cn("text-xs", diversificationColor)}>
                {diversificationLabel}
              </span>
            </div>
          </div>

          {/* Sector Count */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon icon={Layers} size="md" aria-hidden="true" />
              <span>Sectors</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold">
                {sectorCount > 0 ? sectorCount : "—"}
              </span>
            </div>
          </div>

          {/* Average Yield */}
          {avgYield !== null && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon icon={Percent} size="md" aria-hidden="true" />
                <span>Avg Yield</span>
              </div>
              <span className="text-lg font-bold text-emerald-500">
                {formatPercent(avgYield)}
              </span>
            </div>
          )}

          {/* Total Cost Basis */}
          {weightedCostBasis !== null && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon icon={DollarSign} size="md" aria-hidden="true" />
                <span>Cost Basis</span>
              </div>
              <span className="text-lg font-bold">
                {formatCurrency(weightedCostBasis)}
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default PortfolioMetricsCard;
