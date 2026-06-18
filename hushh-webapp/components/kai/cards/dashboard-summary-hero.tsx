"use client";

import * as React from "react";
import { ArrowUpRight, ArrowDownRight, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

// Extracted for performance
const formatCurrency = (val: number | undefined | null) =>
  (val != null && Number.isFinite(val))
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(val)
    : "—";

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
  totalValue, netChange = 0, changePct = 0, holdingsCount = 0,
  riskLabel, brokerageName, periodLabel = "Past Month",
  periodRange, beginningBalance, onViewDetails
}: DashboardSummaryHeroProps) {

  const isPositive = (netChange ?? 0) >= 0;
  const isLoading = totalValue === undefined || totalValue === null;

  if (isLoading) {
    return (
      <Card className="h-56 animate-pulse flex items-center justify-center bg-muted/20">
        <span className="text-muted-foreground text-sm font-medium">Analyzing Portfolio...</span>
      </Card>
    );
  }

  return (
    <Card variant="none" effect="glass" preset="hero" className="overflow-hidden">
      <CardContent className="p-5 sm:p-6 space-y-5">

        {/* Header/Badges */}
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm font-medium text-muted-foreground">Total portfolio value</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {[`Risk: ${riskLabel ?? "Moderate"}`, `${holdingsCount} Holdings`, brokerageName]
              .filter(Boolean)
              .map((l, i) => (
                <Badge key={i} variant="outline" className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider">
                  {l}
                </Badge>
              ))}
          </div>

          <h2 className="text-4xl font-semibold tracking-tight">{formatCurrency(totalValue)}</h2>

          {/* Change Indicator */}
          <div className={cn("flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold",
            isPositive ? "bg-emerald-500/10 text-emerald-600" : "bg-rose-500/10 text-rose-500")}>
            <Icon icon={isPositive ? ArrowUpRight : ArrowDownRight} size="sm" />
            <span>{(netChange ?? 0) >= 0 ? "+" : ""}{(netChange ?? 0).toFixed(2)} ({(changePct ?? 0) >= 0 ? "+" : ""}{(changePct ?? 0).toFixed(2)}%)</span>
            <span className="opacity-60 font-normal">| {periodLabel}</span>
          </div>
        </div>

        {/* Footer Stats */}
        <div className="bg-muted/30 rounded-xl p-4 border border-border/50">
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">{periodRange ?? "Current Period"}</span>
            {beginningBalance != null && (
              <div className="flex items-center gap-1">
                <span className="text-xs opacity-70">Start:</span>
                <span className="font-semibold">{formatCurrency(beginningBalance)}</span>
              </div>
            )}
          </div>

          {onViewDetails && (
            <button onClick={onViewDetails} className="mt-4 w-full flex items-center justify-center gap-1 text-xs font-bold text-primary hover:text-primary/80 transition-colors">
              View Analytics <ChevronRight size={14} />
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}