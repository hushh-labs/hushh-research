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
    conservative: "text-green-600 dark:text-green-300",
    balanced: "text-orange-600 dark:text-orange-300",
    aggressive: "text-red-600 dark:text-red-300",
  };
  const kpiIconClassName =
    "rounded-2xl border border-transparent bg-[color:var(--app-card-surface-compact)] p-2 text-muted-foreground shadow-[var(--shadow-xs)]";
  const kpiLabelClassName =
    "text-[11px] font-medium uppercase tracking-normal text-muted-foreground";
  const kpiValueClassName =
    "text-2xl font-semibold tracking-normal text-foreground sm:text-[1.7rem]";
  const actionCardClassName =
    "flex h-full min-h-[132px] flex-col items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-transparent bg-[color:var(--app-card-surface-compact)] p-5 text-left shadow-[var(--shadow-xs)] transition-[background-color,box-shadow,transform] duration-200 hover:bg-[color:var(--app-card-surface-default-solid)] hover:shadow-[var(--app-card-shadow-standard)] hover:-translate-y-0.5";

  return (
    <div className="w-full space-y-5">
      {/* Header */}
      <div className="space-y-1.5">
        <h1 className="text-[1.7rem] font-semibold leading-tight tracking-normal text-foreground sm:text-3xl">
          Portfolio Overview
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Your investment portfolio at a glance
        </p>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {/* Holdings Count */}
        <SurfaceCard>
          <SurfaceCardContent className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className={kpiIconClassName}>
                <Icon icon={PieChart} size="sm" className="text-blue-600 dark:text-blue-300" />
              </span>
              <span className={kpiLabelClassName}>Holdings</span>
            </div>
            <p className={kpiValueClassName}>{holdingsCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tracked positions
            </p>
          </SurfaceCardContent>
        </SurfaceCard>

        {/* Portfolio Value */}
        <SurfaceCard>
          <SurfaceCardContent className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className={kpiIconClassName}>
                <Icon icon={DollarSign} size="sm" className="text-green-600 dark:text-green-300" />
              </span>
              <span className={kpiLabelClassName}>Value Range</span>
            </div>
            <p className={kpiValueClassName}>
              {portfolioValue
                ? valueBucketLabels[portfolioValue] || portfolioValue
                : "N/A"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Estimated range
            </p>
          </SurfaceCardContent>
        </SurfaceCard>

        {/* Performance */}
        <SurfaceCard>
          <SurfaceCardContent className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className={kpiIconClassName}>
                <Icon icon={Activity} size="sm" className="text-orange-600 dark:text-orange-300" />
              </span>
              <span className={kpiLabelClassName}>Performance</span>
            </div>
            <p
              className={cn(
                kpiValueClassName,
                totalGainLossPct !== undefined
                  ? totalGainLossPct >= 0
                    ? "!text-green-600 dark:!text-green-300"
                    : "!text-red-600 dark:!text-red-300"
                  : ""
              )}
            >
              {totalGainLossPct !== undefined
                ? `${totalGainLossPct >= 0 ? "+" : ""}${totalGainLossPct.toFixed(1)}%`
                : "N/A"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Total gain/loss
            </p>
          </SurfaceCardContent>
        </SurfaceCard>

        {/* Risk Profile */}
        <SurfaceCard>
          <SurfaceCardContent className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className={kpiIconClassName}>
                <Icon icon={BarChart3} size="sm" className="text-purple-600 dark:text-purple-300" />
              </span>
              <span className={kpiLabelClassName}>Risk Profile</span>
            </div>
            <p className={cn(kpiValueClassName, "capitalize", riskColors[riskProfile])}>
              {riskProfile}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Investment style
            </p>
          </SurfaceCardContent>
        </SurfaceCard>
      </div>

      {/* Winners/Losers Card */}
      {(winnersCount > 0 || losersCount > 0) && (
        <SurfaceCard>
          <SurfaceCardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Icon icon={TrendingUp} size="md" className="text-green-600 dark:text-green-300" />
                <div>
                  <p className="text-2xl font-semibold tracking-normal">{winnersCount}</p>
                  <p className="text-xs text-muted-foreground">Winners</p>
                </div>
              </div>
              <div className="h-12 w-px bg-border" />
              <div className="flex items-center gap-3">
                <Icon icon={TrendingDown} size="md" className="text-red-600 dark:text-red-300" />
                <div>
                  <p className="text-2xl font-semibold tracking-normal">{losersCount}</p>
                  <p className="text-xs text-muted-foreground">Losers</p>
                </div>
              </div>
            </div>
          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {/* Quick Actions */}
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Quick Actions</SurfaceCardTitle>
          <SurfaceCardDescription>
            Common tasks for managing your portfolio
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {/* Review Losers */}
            {losersCount > 0 && onReviewLosers && (
              <MorphyButton
                variant="none"
                effect="fade"
                className={actionCardClassName}
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
                className={actionCardClassName}
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
                className={actionCardClassName}
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
                className={actionCardClassName}
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
        <SurfaceCardContent className="p-5">
          <div className="flex items-start gap-3">
            <Icon icon={Activity} size="md" className="text-primary mt-0.5 shrink-0" />
            <div>
              <h4 className="mb-1 text-sm font-semibold tracking-normal">About Your Portfolio</h4>
              <p className="text-sm leading-6 text-muted-foreground">
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
