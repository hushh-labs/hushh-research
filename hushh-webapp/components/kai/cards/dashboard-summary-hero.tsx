"use client";

import { ArrowUpRight, ArrowDownRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

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
  if (normalized === "moderate") return "Moderate";
  if (normalized === "aggressive") return "Aggressive";
  return "Moderate";
}

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
    <Card variant="none" effect="glass" preset="hero" glassAccent="soft">
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="space-y-2 text-center">
          <p className="text-sm font-medium text-muted-foreground">Total portfolio value</p>
          <div className="flex items-center justify-center gap-2">
            <Badge className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Risk: {normalizeRiskLabel(riskLabel)}
            </Badge>
            <Badge className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Holdings: {holdingsCount}
            </Badge>
            {brokerageName && (
              <Badge className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {brokerageName}
              </Badge>
            )}
          </div>
          <h2 className="text-[34px] font-medium leading-tight tracking-normal">{formatCurrency(totalValue)}</h2>
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className={positive ? "text-emerald-600" : "text-red-500"}>
              <span className="inline-flex items-center font-medium">
                <Icon icon={positive ? ArrowUpRight : ArrowDownRight} size="sm" className="mr-1" />
                {formatChange(netChange)} ({changePct >= 0 ? "+" : ""}
                {changePct.toFixed(2)}%)
              </span>
            </span>
            <span className="text-muted-foreground">•</span>
            <span className="font-medium text-muted-foreground">{periodLabel}</span>
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-muted/40 p-3 text-center">
          <div className="space-y-1">
            <p className="text-sm font-medium">{periodRange ?? "Current Statement Period"}</p>
            {typeof beginningBalance === "number" && (
              <p className="text-xs text-muted-foreground">
                Beginning Balance: <span className="font-medium text-foreground">{formatCurrency(beginningBalance)}</span>
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
