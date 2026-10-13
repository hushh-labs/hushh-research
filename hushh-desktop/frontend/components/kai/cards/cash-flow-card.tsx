// components/kai/cards/cash-flow-card.tsx

/**
 * Cash Flow Card - Cash activity summary
 * 
 * Features:
 * - Shows opening and closing cash balances
 * - Displays deposits, withdrawals, and net activity
 * - Color-coded positive/negative flows
 * - Responsive and mobile-friendly
 */

"use client";

import { Banknote, ArrowDownLeft, ArrowUpRight, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES
// =============================================================================

export interface CashFlow {
  opening_balance?: number;
  deposits?: number;
  withdrawals?: number;
  dividends_received?: number;
  interest_received?: number;
  trades_proceeds?: number;
  trades_cost?: number;
  fees_paid?: number;
  closing_balance?: number;
}

interface CashFlowCardProps {
  cashFlow?: CashFlow;
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
// FLOW ROW
// =============================================================================

interface FlowRowProps {
  label: string;
  value: number;
  type?: "positive" | "negative" | "neutral";
  highlight?: boolean;
  icon?: React.ReactNode;
}

function FlowRow({ label, value, type = "neutral", highlight, icon }: FlowRowProps) {
  const colorClass = type === "positive" 
    ? "text-emerald-500" 
    : type === "negative" 
      ? "text-red-500" 
      : "text-foreground";
  
  return (
    <div className={cn(
      "flex justify-between items-center",
      highlight ? "py-2" : "py-1"
    )}>
      <div className="flex items-center gap-2">
        {icon}
        <span className={cn(
          "text-sm",
          highlight ? "font-medium text-foreground" : "text-muted-foreground"
        )}>
          {label}
        </span>
      </div>
      <span className={cn(
        "text-sm font-medium",
        highlight ? "text-lg font-bold" : "",
        colorClass
      )}>
        {type === "positive" && value > 0 && "+"}
        {type === "negative" && value > 0 && "-"}
        {formatCurrency(Math.abs(value))}
      </span>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function CashFlowCard({ cashFlow, className }: CashFlowCardProps) {
  if (!cashFlow) {
    return null;
  }

  const {
    opening_balance = 0,
    deposits = 0,
    withdrawals = 0,
    dividends_received = 0,
    interest_received = 0,
    trades_proceeds = 0,
    trades_cost = 0,
    fees_paid = 0,
    closing_balance = 0,
  } = cashFlow;

  // Calculate net activity
  const netActivity = closing_balance - opening_balance;
  const isPositiveNet = netActivity >= 0;

  // Check if we have meaningful data
  const hasData = opening_balance > 0 || closing_balance > 0 || 
    deposits > 0 || withdrawals > 0;

  if (!hasData) {
    return null;
  }

  return (
    <Card variant="none" effect="glass" showRipple={false} className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon icon={Banknote} size="md" />
          Cash Flow
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {/* Opening Balance */}
        <FlowRow 
          label="Opening Balance" 
          value={opening_balance}
        />
        
        {/* Credits */}
        {deposits > 0 && (
          <FlowRow 
            label="Deposits" 
            value={deposits}
            type="positive"
            icon={<Icon icon={ArrowDownLeft} size="sm" className="text-emerald-500" />}
          />
        )}
        {dividends_received > 0 && (
          <FlowRow 
            label="Dividends" 
            value={dividends_received}
            type="positive"
          />
        )}
        {interest_received > 0 && (
          <FlowRow 
            label="Interest" 
            value={interest_received}
            type="positive"
          />
        )}
        {trades_proceeds > 0 && (
          <FlowRow 
            label="Trade Proceeds" 
            value={trades_proceeds}
            type="positive"
          />
        )}
        
        {/* Debits */}
        {withdrawals > 0 && (
          <FlowRow 
            label="Withdrawals" 
            value={withdrawals}
            type="negative"
            icon={<Icon icon={ArrowUpRight} size="sm" className="text-red-500" />}
          />
        )}
        {trades_cost > 0 && (
          <FlowRow 
            label="Trade Costs" 
            value={trades_cost}
            type="negative"
          />
        )}
        {fees_paid > 0 && (
          <FlowRow 
            label="Fees" 
            value={fees_paid}
            type="negative"
          />
        )}
        
        {/* Net Activity */}
        <div className="pt-2 mt-2 border-t border-border">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              {isPositiveNet ? (
                <Icon icon={TrendingUp} size="md" className="text-emerald-500" />
              ) : (
                <Icon icon={TrendingDown} size="md" className="text-red-500" />
              )}
              <span className="text-sm text-muted-foreground">Net Activity</span>
            </div>
            <span className={cn(
              "text-sm font-medium",
              isPositiveNet ? "text-emerald-500" : "text-red-500"
            )}>
              {isPositiveNet ? "+" : ""}{formatCurrency(netActivity)}
            </span>
          </div>
        </div>
        
        {/* Closing Balance */}
        <div className="pt-2 border-t border-border">
          <FlowRow 
            label="Closing Balance" 
            value={closing_balance}
            highlight
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default CashFlowCard;
