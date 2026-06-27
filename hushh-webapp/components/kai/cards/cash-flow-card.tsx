"use client";

import { useState } from "react";
import { Banknote, ArrowDownLeft, ArrowUpRight, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from "lucide-react";
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

export interface CashFlowCardProps {
  cashFlow?: CashFlow;
  className?: string;
}

interface FlowRowProps {
  label: string;
  value: number;
  type?: "positive" | "negative" | "neutral";
  highlight?: boolean;
  icon?: React.ReactNode;
}

// =============================================================================
// HELPER COMPONENTS & FUNCTIONS
// =============================================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function FlowRow({ label, value, type = "neutral", highlight, icon }: FlowRowProps) {
  const colorClass = type === "positive"
    ? "text-emerald-500"
    : type === "negative"
      ? "text-red-500"
      : "text-foreground";

  return (
    <div className={cn("flex justify-between items-center", highlight ? "py-2" : "py-1")}>
      <div className="flex items-center gap-2">
        {icon}
        <span className={cn("text-sm", highlight ? "font-medium text-foreground" : "text-muted-foreground")}>
          {label}
        </span>
      </div>
      <span className={cn("text-sm font-medium", highlight ? "text-lg font-bold" : "", colorClass)}>
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
  const [showDetails, setShowDetails] = useState(false);

  if (!cashFlow || Object.keys(cashFlow).length === 0) return null;

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

  const netActivity = closing_balance - opening_balance;
  const isPositiveNet = netActivity >= 0;

  return (
    <Card variant="none" effect="glass" className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon icon={Banknote} size="md" />
            Cash Flow
          </div>
          <button onClick={() => setShowDetails(!showDetails)} className="text-muted-foreground hover:text-foreground">
            {showDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <FlowRow label="Opening Balance" value={opening_balance} />
        <FlowRow label="Deposits" value={deposits} type="positive" icon={<ArrowDownLeft size={14} className="text-emerald-500" />} />
        <FlowRow label="Withdrawals" value={withdrawals} type="negative" icon={<ArrowUpRight size={14} className="text-red-500" />} />

        <div className={cn("overflow-hidden transition-all duration-300", showDetails ? "max-h-40" : "max-h-0")}>
          <FlowRow label="Dividends" value={dividends_received} type="positive" />
          <FlowRow label="Interest" value={interest_received} type="positive" />
          <FlowRow label="Trade Proceeds" value={trades_proceeds} type="positive" />
          <FlowRow label="Trade Costs" value={trades_cost} type="negative" />
          <FlowRow label="Fees" value={fees_paid} type="negative" />
        </div>

        <div className="pt-2 mt-2 border-t border-border">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Icon icon={isPositiveNet ? TrendingUp : TrendingDown} size="md" className={isPositiveNet ? "text-emerald-500" : "text-red-500"} />
              <span className="text-sm text-muted-foreground">Net Activity</span>
            </div>
            <span className={cn("text-sm font-medium", isPositiveNet ? "text-emerald-500" : "text-red-500")}>
              {isPositiveNet ? "+" : ""}{formatCurrency(netActivity)}
            </span>
          </div>
        </div>

        <div className="pt-2 border-t border-border">
          <FlowRow label="Closing Balance" value={closing_balance} highlight />
        </div>
      </CardContent>
    </Card>
  );
}

export default CashFlowCard;