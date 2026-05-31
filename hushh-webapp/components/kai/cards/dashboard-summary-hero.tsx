"use client";

import { ArrowUpRight, ArrowDownRight, Info } from "lucide-react";
import { cn } from "@/lib/utils"; // Ensure this import path matches your project structure
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// =============================================================================
// TYPES & HELPERS
// =============================================================================

interface DashboardSummaryHeroProps {
  totalValue: number;
  netChange: number;
  changePct: number;
  holdingsCount: number;
  riskLabel?: string;
  brokerageName?: string;
  periodLabel?: string;
  periodRange?: string;
  beginningBalance?: number;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

function normalizeRiskLabel(value?: string): string {
  if (!value) return "Moderate";
  const normalized = value.trim().toLowerCase();
  if (normalized === "conservative") return "Conservative";
  if (normalized === "aggressive") return "Aggressive";
  return "Moderate";
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function DashboardSummaryHero({
  totalValue,
  netChange,
  changePct,
  holdingsCount,
  riskLabel,
  brokerageName,
  periodLabel = "Past Month",
  periodRange,
  beginningBalance,
}: DashboardSummaryHeroProps) {
  const positive = netChange >= 0;

  return (
    <Card variant="none" effect="glass" preset="hero" glassAccent="soft" className="w-full overflow-hidden">
      <CardContent className="space-y-6 p-6">
        
        {/* Header/Stats Badges */}
        <div className="flex flex-wrap justify-center gap-2">
          {[
            { label: `Risk: ${normalizeRiskLabel(riskLabel)}` },
            { label: `${holdingsCount} Holdings` },
            ...(brokerageName ? [{ label: brokerageName }] : [])
          ].map((b, i) => (
            <Badge key={i} variant="secondary" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-wider font-bold opacity-80">
              {b.label}
            </Badge>
          ))}
        </div>

        {/* Main Value */}
        <div className="text-center space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Total Value</p>
          <h2 className="text-5xl font-black tracking-tighter">{formatCurrency(totalValue)}</h2>
          
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn("inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold cursor-help", 
                    positive ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-500")}>
                  <Icon icon={positive ? ArrowUpRight : ArrowDownRight} size="sm" />
                  {formatChange(netChange)} ({changePct.toFixed(2)}%)
                </div>
              </TooltipTrigger>
              <TooltipContent>Performance relative to beginning balance</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-border/40 bg-muted/20 p-4">
          <div className="text-center">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Period</p>
            <p className="text-sm font-semibold">{periodLabel}</p>
          </div>
          <div className="text-center border-l border-border/40">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Opening</p>
            <p className="text-sm font-semibold">{beginningBalance ? formatCurrency(beginningBalance) : "N/A"}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}