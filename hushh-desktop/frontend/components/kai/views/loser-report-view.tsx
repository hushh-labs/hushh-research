// components/kai/views/loser-report-view.tsx

/**
 * Loser Report View - Full-screen display of portfolio positions that need attention
 *
 * Features:
 * - Grid/list of losing positions
 * - Sortable by loss %, value
 * - Click to analyze individual stock
 * - "Analyze All" action button
 */

"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/lib/morphy-ux/card";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";

import {
  AlertTriangle,
  TrendingDown,
  BarChart3,
  ArrowUpDown,
} from "lucide-react";

// =============================================================================
// TYPES
// =============================================================================

interface Loser {
  symbol: string;
  name: string;
  gain_loss_pct: number;
  gain_loss: number;
  current_value: number;
}

interface LoserReportViewProps {
  losers: Loser[];
  totalLoss?: number;
  onAnalyzeStock: (symbol: string) => void;
  onAnalyzeAll?: () => void;
  onContinue?: () => void;
}

type SortBy = "loss_pct" | "value" | "loss_amount";

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function LoserReportView({
  losers,
  totalLoss,
  onAnalyzeStock,
  onAnalyzeAll,
  onContinue,
}: LoserReportViewProps) {
  const [sortBy, setSortBy] = useState<SortBy>("loss_pct");

  // Sort losers based on selected criteria
  const sortedLosers = [...losers].sort((a, b) => {
    switch (sortBy) {
      case "loss_pct":
        return a.gain_loss_pct - b.gain_loss_pct;
      case "value":
        return b.current_value - a.current_value;
      case "loss_amount":
        return a.gain_loss - b.gain_loss;
      default:
        return 0;
    }
  });

  // Calculate total loss if not provided
  const calculatedTotalLoss =
    totalLoss ?? losers.reduce((sum, l) => sum + l.gain_loss, 0);

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6 p-6">
      {/* Header */}
        <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 rounded-full text-red-600 dark:text-red-400 mb-2">
          <Icon icon={AlertTriangle} size="md" />
          <span className="font-semibold">{losers.length} Positions Need Attention</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Portfolio Losers</h1>
        <p className="text-muted-foreground">
          These positions are underperforming. Let's analyze them.
        </p>
        {calculatedTotalLoss < 0 && (
          <p className="text-lg font-semibold text-red-600 dark:text-red-400">
            Total Loss: ${Math.abs(calculatedTotalLoss).toLocaleString()}
          </p>
        )}
      </div>

      {/* Sort Controls */}
      <Card variant="none" effect="glass" showRipple={false}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground flex items-center gap-2">
              <Icon icon={ArrowUpDown} size="sm" />
              Sort by:
            </span>
            <MorphyButton
              variant={sortBy === "loss_pct" ? "gradient" : "none"}
              effect="glass"
              size="sm"
              onClick={() => setSortBy("loss_pct")}
            >
              Loss %
            </MorphyButton>
            <MorphyButton
              variant={sortBy === "value" ? "gradient" : "none"}
              effect="glass"
              size="sm"
              onClick={() => setSortBy("value")}
            >
              Portfolio Value
            </MorphyButton>
            <MorphyButton
              variant={sortBy === "loss_amount" ? "gradient" : "none"}
              effect="glass"
              size="sm"
              onClick={() => setSortBy("loss_amount")}
            >
              Loss Amount
            </MorphyButton>

          </div>
        </CardContent>
      </Card>

      {/* Losers Grid */}
      <div className="grid gap-4">
        {sortedLosers.map((loser) => (
          <Card
            key={loser.symbol}
            variant="none"
            effect="glass"
            showRipple={true}
            className="cursor-pointer hover:border-red-500/50 transition-all"
            onClick={() => onAnalyzeStock(loser.symbol)}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-4">
                {/* Left: Stock Info */}
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
                    <Icon icon={TrendingDown} size="lg" className="text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">{loser.symbol}</h3>
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {loser.name}
                    </p>
                  </div>
                </div>

                {/* Right: Metrics */}
                <div className="flex items-center gap-6">
                  {/* Loss Percentage */}
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Loss</p>
                    <p className="text-xl font-bold text-red-600 dark:text-red-400">
                      {loser.gain_loss_pct.toFixed(1)}%
                    </p>
                  </div>

                  {/* Loss Amount */}
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Amount</p>
                    <p className="text-lg font-semibold text-red-600 dark:text-red-400">
                      ${Math.abs(loser.gain_loss).toLocaleString()}
                    </p>
                  </div>

                  {/* Current Value */}
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Value</p>
                    <p className="text-lg font-semibold">
                      ${loser.current_value.toLocaleString()}
                    </p>
                  </div>

                  {/* Analyze Icon */}
                  <Icon icon={BarChart3} size="md" className="text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-4 justify-center pt-4">
        {onAnalyzeAll && losers.length > 1 && (
          <MorphyButton
            variant="gradient"
            effect="glass"
            size="lg"
            onClick={onAnalyzeAll}
            icon={{
              icon: BarChart3,
              gradient: true,
            }}
          >
            Analyze All {losers.length} Positions
          </MorphyButton>
        )}
        {onContinue && (
          <MorphyButton
            variant="none"
            effect="glass"
            size="lg"
            onClick={onContinue}
          >
            Continue to Overview
          </MorphyButton>
        )}

      </div>

      {/* Info Card */}
      <Card variant="muted" effect="glass" showRipple={false}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Icon icon={AlertTriangle} size="md" className="text-amber-500" />
            What This Means
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            These positions are currently below their cost basis. Click on any position
            to get Kai's analysis with buy, hold, or reduce recommendations based on
            fundamental data and market conditions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
