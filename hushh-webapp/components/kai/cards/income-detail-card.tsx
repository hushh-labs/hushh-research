"use client";

import { DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES
// =============================================================================

export interface IncomeDetail {
  dividends_taxable?: number;
  dividends_qualified?: number;
  dividends_nontaxable?: number;
  interest_taxable?: number;
  interest_tax_exempt?: number;
  short_term_cap_gains?: number;
  long_term_cap_gains?: number;
  return_of_capital?: number;
}

export interface IncomeSummary {
  dividends?: number;
  interest?: number;
  total?: number;
}

export interface YtdMetrics {
  income_ytd?: number;
  realized_gain_loss_ytd?: number;
}

export interface IncomeDetailCardProps {
  incomeSummary?: IncomeSummary;
  incomeDetail?: IncomeDetail;
  ytdMetrics?: YtdMetrics;
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS & COMPONENTS
// =============================================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

interface IncomeRowProps {
  label: string;
  value: number;
  subLabel?: string;
  highlight?: boolean;
}

function IncomeRow({ label, value, subLabel, highlight }: IncomeRowProps) {
  return (
    <div className={cn("flex justify-between items-center text-sm", highlight && "font-medium")}>
      <div>
        <span className={highlight ? "text-foreground" : "text-muted-foreground"}>
          {label}
        </span>
        {subLabel && <span className="text-xs text-muted-foreground ml-1">({subLabel})</span>}
      </div>
      <span className={cn(value > 0 ? "text-emerald-500" : "text-foreground", highlight && "font-semibold")}>
        {formatCurrency(value)}
      </span>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function IncomeDetailCard({
  incomeSummary,
  incomeDetail,
  ytdMetrics,
  className
}: IncomeDetailCardProps) {

  const totalIncome = incomeSummary?.total ?? ((incomeSummary?.dividends ?? 0) + (incomeSummary?.interest ?? 0));

  const incomeItems = [
    { label: "Dividends (Taxable)", value: incomeDetail?.dividends_taxable },
    { label: "Qualified Dividends", value: incomeDetail?.dividends_qualified },
    { label: "Tax-Exempt Dividends", value: incomeDetail?.dividends_nontaxable },
    { label: "Interest (Taxable)", value: incomeDetail?.interest_taxable },
    { label: "Tax-Exempt Interest", value: incomeDetail?.interest_tax_exempt },
    { label: "ST Cap Gains", value: incomeDetail?.short_term_cap_gains },
    { label: "LT Cap Gains", value: incomeDetail?.long_term_cap_gains },
    { label: "Return of Capital", value: incomeDetail?.return_of_capital },
  ].filter((item) => (item.value ?? 0) > 0);

  if (totalIncome === 0 && incomeItems.length === 0) return null;

  return (
    <Card variant="none" effect="glass" className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon icon={DollarSign} size="md" /> Income
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="text-center py-2 space-y-1">
          <p className="text-3xl font-bold text-emerald-500">{formatCurrency(totalIncome)}</p>
          <div className="text-xs text-muted-foreground">This Period</div>
        </div>

        <div className="space-y-2 pt-2 border-t border-border">
          {incomeItems.length > 0 ? (
            incomeItems.map((item, idx) => (
              <IncomeRow key={idx} label={item.label} value={item.value ?? 0} />
            ))
          ) : (
            <>
              <IncomeRow label="Dividends" value={incomeSummary?.dividends ?? 0} />
              <IncomeRow label="Interest" value={incomeSummary?.interest ?? 0} />
            </>
          )}
        </div>

        {ytdMetrics?.income_ytd && (
          <div className="pt-2 border-t border-border">
            <IncomeRow label="YTD Total" value={ytdMetrics.income_ytd} highlight />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default IncomeDetailCard;