// components/kai/cards/top-movers-card.tsx

/**
 * Top Movers Card
 * 
 * Features:
 * - Shows top gainers and losers from portfolio
 * - Color-coded for quick visual identification
 * - Compact display with symbol, % change, and $ change
 */

"use client";

import { useMemo } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

interface Holding {
  symbol: string;
  name: string;
  market_value: number;
  unrealized_gain_loss?: number;
  unrealized_gain_loss_pct?: number;
}

interface TopMoversCardProps {
  holdings: Holding[];
  maxItems?: number;
  className?: string;
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function TopMoversCard({
  holdings,
  maxItems = 3,
  className,
}: TopMoversCardProps) {
  // Get top gainers and losers
  const { gainers, losers } = useMemo(() => {
    // Filter holdings that have actual non-zero percentage changes
    const withGainLoss = holdings.filter(
      (h) => h.unrealized_gain_loss_pct !== undefined && 
             h.unrealized_gain_loss_pct !== 0 &&
             !isNaN(h.unrealized_gain_loss_pct)
    );
    
    // Sort by absolute percentage change for better ranking
    const sortedGainers = [...withGainLoss]
      .filter((h) => h.unrealized_gain_loss_pct! > 0)
      .sort((a, b) => (b.unrealized_gain_loss_pct || 0) - (a.unrealized_gain_loss_pct || 0))
      .slice(0, maxItems);
    
    const sortedLosers = [...withGainLoss]
      .filter((h) => h.unrealized_gain_loss_pct! < 0)
      .sort((a, b) => (a.unrealized_gain_loss_pct || 0) - (b.unrealized_gain_loss_pct || 0))
      .slice(0, maxItems);
    
    return { gainers: sortedGainers, losers: sortedLosers };
  }, [holdings, maxItems]);

  if (gainers.length === 0 && losers.length === 0) {
    return null;
  }

  return (
    <Card variant="none" effect="glass" showRipple={false} className={className}>
      <CardHeader className="pb-1 pt-3 px-4">
        <CardTitle className="text-sm font-semibold">Top Movers</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          {/* Gainers Column */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-emerald-500 font-medium">
              <Icon icon={TrendingUp} size="md" />
              <span>Gainers</span>
            </div>
            {gainers.length > 0 ? (
              <div className="space-y-1.5">
                {gainers.map((holding, index) => (
                  <div
                    key={`gainer-${holding.symbol}-${index}`}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="font-medium truncate">{holding.symbol}</span>
                    <span className="text-emerald-500 font-medium">
                      {formatPercent(holding.unrealized_gain_loss_pct || 0)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">None</p>
            )}
          </div>

          {/* Losers Column */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-red-500 font-medium">
              <Icon icon={TrendingDown} size="md" />
              <span>Losers</span>
            </div>
            {losers.length > 0 ? (
              <div className="space-y-1.5">
                {losers.map((holding, index) => (
                  <div
                    key={`loser-${holding.symbol}-${index}`}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="font-medium truncate">{holding.symbol}</span>
                    <span className="text-red-500 font-medium">
                      {formatPercent(holding.unrealized_gain_loss_pct || 0)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">None</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default TopMoversCard;
