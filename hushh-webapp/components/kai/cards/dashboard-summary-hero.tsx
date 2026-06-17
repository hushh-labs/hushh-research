"use client";

import { ArrowUpRight, ArrowDownRight, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

// =============================================================================
// HELPERS
// =============================================================================

const formatCurrency = (value: number | undefined | null) => {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

const formatChange = (value: number | undefined | null) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${formatCurrency(Math.abs(value))}`;
};

const normalizeRiskLabel = (value?: string) => {
  const normalized = value?.trim().toLowerCase();
  const options: Record<string, string> = {
    conservative: "Conservative",
    moderate: "Moderate",
    aggressive: "Aggressive",
  };
  return options[normalized || ""] ?? "Moderate";
};

// =============================================================================
// COMPONENT
// =============================================================================

interface DashboardSummaryHeroProps {
  totalValue?: number | null;
  netChange?: number | null;
  changePct?: number | null;
  holdingsCount?: number;
  riskLabel?: string;
  brokerageName?: string;
  periodLabel?: string;
  periodRange?: string;
  beginningBalance?: number | null;
  onViewDetails?: () => void;
}

export function DashboardSummaryHero({
  totalValue,
  netChange = 0,
  changePct = 0,
  holdingsCount = 0,
  riskLabel,
  brokerageName,
  periodLabel = "Past Month",
  periodRange,
  beginningBalance,
  onViewDetails,
}: DashboardSummaryHeroProps) {
  const isPositive = (netChange ?? 0) >= 0;
  const isLoading = totalValue === undefined || totalValue === null;

  return (
    <Card variant="none" effect="glass" preset="hero" glassAccent="soft">
      <CardContent className="space-y-4 p-5 sm:p-6">
        {isLoading ? (
          <div className="flex h-40 animate-pulse items-center justify-center text-muted-foreground">
            Loading Portfolio...
          </div>
        ) : (
          <div className="space-y-2 text-center">
            <p className="text-sm font-medium text-muted-foreground">Total portfolio value</p>

            <div className="flex flex-wrap items-center justify-center gap-2">
              {[
                `Risk: ${normalizeRiskLabel(riskLabel)}`,
                `${holdingsCount} Holdings`,
                brokerageName
              ].filter(Boolean).map((label, i) => (
                <Badge key={i} variant="outline" className="rounded-full bg-muted/50 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {label}
                </Badge>
              ))}
            </div>

            <h2 className="text-[28px] font-medium leading-tight tracking-normal sm:text-[32px]">
              {formatCurrency(totalValue)}
            </h2>

            <div className="flex items-center justify-center gap-2 text-sm">
              <span className={cn("inline-flex items-center font-medium", isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400")}>
                <Icon icon={isPositive ? ArrowUpRight : ArrowDownRight} size="sm" className="mr-1" />
                {formatChange(netChange)} ({(changePct ?? 0) >= 0 ? "+" : ""}{changePct?.toFixed(2) ?? "0.00"}%)
              </span>
              <span className="text-muted-foreground">•</span>
              <span className="font-medium text-muted-foreground">{periodLabel}</span>
            </div>
          </div>
        )}

        {!isLoading && (
          <div className="rounded-xl border border-border/60 bg-muted/40 p-3 text-center transition-all hover:bg-muted/60">
            <p className="text-sm font-medium">{periodRange ?? "Current Statement Period"}</p>
            {beginningBalance != null && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Starting: <span className="font-semibold text-foreground">{formatCurrency(beginningBalance)}</span>
              </p>
            )}

            {onViewDetails && (
              <button
                onClick={onViewDetails}
                className="mt-3 flex w-full items-center justify-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                View Full Analytics <Icon icon={ChevronRight} size="xs" />
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
