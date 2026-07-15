// components/kai/cards/income-detail-card.tsx

/**
 * Income Detail Card - Detailed income breakdown
 * 
 * Features:
 * - Shows total income with period and YTD
 * - Breaks down by type: dividends, interest, capital gains
 * - Distinguishes taxable vs tax-exempt income
 * - Responsive and mobile-friendly
 */

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

interface IncomeDetailCardProps {
  incomeSummary?: IncomeSummary;
  incomeDetail?: IncomeDetail;
  ytdMetrics?: YtdMetrics;
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// =============================================================================
// INCOME ROW
// =============================================================================

interface IncomeRowProps {
  label: string;
  value: number;
  subLabel?: string;
  highlight?: boolean;
}

function IncomeRow({ label, value, subLabel, highlight }: IncomeRowProps) {
  return (
    <div className={cn(
      "flex justify-between items-center text-sm",
      highlight && "font-medium"
    )}>
      <div>
        <span className={highlight ? "text-foreground" : "text-muted-foreground"}>
          {label}
        </span>
        {subLabel && (
          <span className="text-xs text-muted-foreground ml-1">({subLabel})</span>
        )}
      </div>
      <span className={cn(
        value > 0 ? "text-emerald-500" : "text-foreground",
        highlight && "font-semibold"
      )}>
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
  // Calculate total income from various sources
  const totalIncome = incomeSummary?.total || 
    ((incomeSummary?.dividends || 0) + (incomeSummary?.interest || 0));
  
  // Check if we have detailed breakdown
  const hasDetail = incomeDetail && (
    incomeDetail.dividends_taxable ||
    incomeDetail.dividends_qualified ||
    incomeDetail.interest_taxable ||
    incomeDetail.short_term_cap_gains ||
    incomeDetail.long_term_cap_gains
  );

  // Check if we have any income data
  const hasIncome = totalIncome > 0 || 
    (incomeSummary?.dividends && incomeSummary.dividends > 0) ||
    (incomeSummary?.interest && incomeSummary.interest > 0);

  if (!hasIncome && !hasDetail) {
    return null;
  }

  return (
    <Card variant="none" effect="glass" showRipple={false} className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon icon={DollarSign} size="md" />
          Income
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Total Income */}
        <div className="text-center py-2">
          <p className="text-2xl font-bold text-emerald-500">
            {formatCurrency(totalIncome)}
          </p>
          <p className="text-xs text-muted-foreground">This Period</p>
        </div>
        
        {/* Detailed Breakdown */}
        {hasDetail && (
          <div className="space-y-2 pt-2 border-t border-border">
            {/* Dividends */}
            {(incomeDetail?.dividends_taxable || 0) > 0 && (
              <IncomeRow 
                label="Dividends" 
                value={incomeDetail!.dividends_taxable!}
                subLabel="taxable"
              />
            )}
            {(incomeDetail?.dividends_qualified || 0) > 0 && (
              <IncomeRow 
                label="Qualified Dividends" 
                value={incomeDetail!.dividends_qualified!}
              />
            )}
            {(incomeDetail?.dividends_nontaxable || 0) > 0 && (
              <IncomeRow 
                label="Tax-Exempt Dividends" 
                value={incomeDetail!.dividends_nontaxable!}
              />
            )}
            
            {/* Interest */}
            {(incomeDetail?.interest_taxable || 0) > 0 && (
              <IncomeRow 
                label="Interest" 
                value={incomeDetail!.interest_taxable!}
                subLabel="taxable"
              />
            )}
            {(incomeDetail?.interest_tax_exempt || 0) > 0 && (
              <IncomeRow 
                label="Tax-Exempt Interest" 
                value={incomeDetail!.interest_tax_exempt!}
              />
            )}
            
            {/* Capital Gains */}
            {(incomeDetail?.short_term_cap_gains || 0) > 0 && (
              <IncomeRow 
                label="ST Cap Gains" 
                value={incomeDetail!.short_term_cap_gains!}
              />
            )}
            {(incomeDetail?.long_term_cap_gains || 0) > 0 && (
              <IncomeRow 
                label="LT Cap Gains" 
                value={incomeDetail!.long_term_cap_gains!}
              />
            )}
            
            {/* Return of Capital */}
            {(incomeDetail?.return_of_capital || 0) > 0 && (
              <IncomeRow 
                label="Return of Capital" 
                value={incomeDetail!.return_of_capital!}
              />
            )}
          </div>
        )}
        
        {/* Simple Breakdown (fallback) */}
        {!hasDetail && (incomeSummary?.dividends || incomeSummary?.interest) && (
          <div className="space-y-2 pt-2 border-t border-border">
            {(incomeSummary?.dividends || 0) > 0 && (
              <IncomeRow label="Dividends" value={incomeSummary!.dividends!} />
            )}
            {(incomeSummary?.interest || 0) > 0 && (
              <IncomeRow label="Interest" value={incomeSummary!.interest!} />
            )}
          </div>
        )}
        
        {/* YTD Total */}
        {ytdMetrics?.income_ytd && ytdMetrics.income_ytd > 0 && (
          <div className="pt-2 border-t border-border">
            <IncomeRow 
              label="YTD Total" 
              value={ytdMetrics.income_ytd}
              highlight
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default IncomeDetailCard;
