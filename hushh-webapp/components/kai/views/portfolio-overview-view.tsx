// components/kai/views/portfolio-overview-view.tsx

/**
 * Portfolio Overview View - Dashboard showing portfolio summary and quick actions
 *
 * Features:
 * - Summary cards (total value, gain/loss, risk profile)
 * - Quick actions: Review Losers, Import New, Settings
 * - Recent analysis history
 */

"use client";

import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";

import {
  TrendingUp,
  TrendingDown,
  PieChart,
  AlertTriangle,
  Upload,
  Settings,
  BarChart3,
  DollarSign,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES
// =============================================================================

interface PortfolioOverviewViewProps {
  holdingsCount: number;
  portfolioValue?: string;
  totalGainLossPct?: number;
  winnersCount?: number;
  losersCount?: number;
  riskProfile?: string;
  kpis?: Record<string, unknown>;
  onReviewLosers?: () => void;
  onImportNew?: () => void;
  onSettings?: () => void;
  onAnalyzeStock?: (symbol?: string) => void;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function PortfolioOverviewView({
  holdingsCount,
  portfolioValue,
  totalGainLossPct,
  winnersCount = 0,
  losersCount = 0,
  riskProfile = "balanced",
  kpis: _kpis,
  onReviewLosers,
  onImportNew,
  onSettings,
  onAnalyzeStock,
}: PortfolioOverviewViewProps) {
  const valueBucketLabels: Record<string, string> = {
    under_10k: "< $10K",
    "10k_50k": "$10K - $50K",
    "50k_100k": "$50K - $100K",
    "100k_500k": "$100K - $500K",
    "500k_1m": "$500K - $1M",
    over_1m: "> $1M",
  };

  const riskColors: Record<string, string> = {
    conservative: "text-emerald-500",
    balanced: "text-amber-500",
    aggressive: "text-red-500",
  };

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Portfolio Overview</h1>
        <p className="text-muted-foreground">
          Your investment portfolio at a glance
        </p>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Holdings Count */}
        <SurfaceCard>
          <SurfaceCardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <Icon icon={PieChart} size="md" className="text-primary" />
              <span className="text-xs text-muted-foreground">Holdings</span>
            </div>
            <p className="text-3xl font-bold">{holdingsCount}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Tracked positions
            </p>
          </SurfaceCardContent>
        </SurfaceCard>

        {/* Portfolio Value */}
        <SurfaceCard>
          <SurfaceCardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <Icon icon={DollarSign} size="md" className="text-primary" />
              <span className="text-xs text-muted-foreground">Value Range</span>
            </div>
            <p className="text-2xl font-bold">
              {portfolioValue
                ? valueBucketLabels[portfolioValue] || portfolioValue
                : "N/A"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Estimated range
            </p>
          </SurfaceCardContent>
        </SurfaceCard>

        {/* Performance */}
        <SurfaceCard>
          <SurfaceCardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <Icon icon={Activity} size="md" className="text-primary" />
              <span className="text-xs text-muted-foreground">Performance</span>
            </div>
            <p
              className={cn(
                "text-3xl font-bold",
                totalGainLossPct !== undefined
                  ? totalGainLossPct >= 0
                    ? "text-emerald-500"
                    : "text-red-500"
                  : ""
              )}
            >
              {totalGainLossPct !== undefined
                ? `${totalGainLossPct >= 0 ? "+" : ""}${totalGainLossPct.toFixed(1)}%`
                : "N/A"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Total gain/loss
            </p>
          </SurfaceCardContent>
        </SurfaceCard>

        {/* Risk Profile */}
        <SurfaceCard>
          <SurfaceCardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <Icon icon={BarChart3} size="md" className="text-primary" />
              <span className="text-xs text-muted-foreground">Risk Profile</span>
            </div>
            <p className={cn("text-2xl font-bold capitalize", riskColors[riskProfile])}>
              {riskProfile}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Investment style
            </p>
          </SurfaceCardContent>
        </SurfaceCard>
      </div>

      {/* Winners/Losers Card */}
      {(winnersCount > 0 || losersCount > 0) && (
        <SurfaceCard>
          <SurfaceCardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Icon icon={TrendingUp} size="md" className="text-emerald-500" />
                <div>
                  <p className="text-2xl font-bold">{winnersCount}</p>
                  <p className="text-sm text-muted-foreground">Winners</p>
                </div>
              </div>
              <div className="h-12 w-px bg-border" />
              <div className="flex items-center gap-4">
                <Icon icon={TrendingDown} size="md" className="text-red-500" />
                <div>
                  <p className="text-2xl font-bold">{losersCount}</p>
                  <p className="text-sm text-muted-foreground">Losers</p>
                </div>
              </div>
            </div>
          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {/* Quick Actions */}
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle className="text-lg">Quick Actions</SurfaceCardTitle>
          <SurfaceCardDescription>
            Common tasks for managing your portfolio
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Review Losers */}
            {losersCount > 0 && onReviewLosers && (
              <MorphyButton
                variant="none"
                effect="fade"
                className="flex h-auto flex-col items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-6 text-left shadow-[var(--shadow-xs)] transition-[background-color,border-color,box-shadow] duration-200 hover:border-[color:var(--app-card-border-strong)] hover:bg-[var(--app-card-surface-default)] hover:shadow-[var(--app-card-shadow-standard)]"
                onClick={onReviewLosers}
                icon={{
                  icon: AlertTriangle,
                  gradient: false,
                }}
              >
                <div className="w-full text-left">
                  <h4 className="font-semibold mb-1">Review Losers</h4>
                  <p className="text-xs text-muted-foreground">
                    {losersCount} position{losersCount > 1 ? "s" : ""} need attention
                  </p>
                </div>
              </MorphyButton>
            )}
            {/* Analyze Stock */}
            {onAnalyzeStock && (
              <MorphyButton
                variant="none"
                effect="fade"
                className="flex h-auto flex-col items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-6 text-left shadow-[var(--shadow-xs)] transition-[background-color,border-color,box-shadow] duration-200 hover:border-[color:var(--app-card-border-strong)] hover:bg-[var(--app-card-surface-default)] hover:shadow-[var(--app-card-shadow-standard)]"
                onClick={() => onAnalyzeStock()}
                icon={{
                  icon: BarChart3,
                  gradient: false,
                }}
              >
                <div className="w-full text-left">
                  <h4 className="font-semibold mb-1">Analyze Stock</h4>
                  <p className="text-xs text-muted-foreground">
                    Get Kai's investment analysis
                  </p>
                </div>
              </MorphyButton>
            )}
            {/* Import New */}
            {onImportNew && (
              <MorphyButton
                variant="none"
                effect="fade"
                className="flex h-auto flex-col items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-6 text-left shadow-[var(--shadow-xs)] transition-[background-color,border-color,box-shadow] duration-200 hover:border-[color:var(--app-card-border-strong)] hover:bg-[var(--app-card-surface-default)] hover:shadow-[var(--app-card-shadow-standard)]"
                onClick={onImportNew}
                icon={{
                  icon: Upload,
                  gradient: false,
                }}
              >
                <div className="w-full text-left">
                  <h4 className="font-semibold mb-1">Import New</h4>
                  <p className="text-xs text-muted-foreground">
                    Update with latest statement
                  </p>
                </div>
              </MorphyButton>
            )}
            {/* Settings */}
            {onSettings && (
              <MorphyButton
                variant="none"
                effect="fade"
                className="flex h-auto flex-col items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-6 text-left shadow-[var(--shadow-xs)] transition-[background-color,border-color,box-shadow] duration-200 hover:border-[color:var(--app-card-border-strong)] hover:bg-[var(--app-card-surface-default)] hover:shadow-[var(--app-card-shadow-standard)]"
                onClick={onSettings}
                icon={{
                  icon: Settings,
                  gradient: false,
                }}
              >
                <div className="w-full text-left">
                  <h4 className="font-semibold mb-1">Settings</h4>
                  <p className="text-xs text-muted-foreground">
                    Risk profile & preferences
                  </p>
                </div>
              </MorphyButton>
            )}

          </div>
        </SurfaceCardContent>
      </SurfaceCard>

      {/* Info Card */}
      <SurfaceCard tone="feature">
        <SurfaceCardContent className="p-6">
          <div className="flex items-start gap-3">
            <Icon icon={Activity} size="md" className="text-primary mt-0.5 shrink-0" />
            <div>
              <h4 className="font-semibold mb-1">About Your Portfolio</h4>
              <p className="text-sm text-muted-foreground">
                Kai tracks your portfolio using encrypted data in your personal vault.
                All analysis happens with your privacy intact. Holdings data is organized
                into the financial domain of your Personal Knowledge Model.
              </p>
            </div>
          </div>
        </SurfaceCardContent>
      </SurfaceCard>
    </div>
  );
}
