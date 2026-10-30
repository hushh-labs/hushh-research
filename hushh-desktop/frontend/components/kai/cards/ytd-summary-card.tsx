// components/kai/cards/ytd-summary-card.tsx

/**
 * YTD Summary Card
 * 
 * Displays year-to-date financial metrics including:
 * - Net deposits/withdrawals
 * - Total income
 * - Fees paid
 * - Investment gain/loss
 */

"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { 
  TrendingUp, 
  TrendingDown, 
  ArrowUpRight, 
  ArrowDownRight,
  Calendar,
  DollarSign,
  Receipt,
  Wallet,
} from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";

export interface YtdData {
  net_deposits_ytd?: number;
  withdrawals_ytd?: number;
  total_income_ytd?: number;
  total_fees?: number;
  investment_gain_loss?: number;
}

interface YtdSummaryCardProps {
  data: YtdData;
  className?: string;
}

function formatCurrency(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (absValue >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

interface MetricItemProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  showSign?: boolean;
  invertColors?: boolean;
}

function MetricItem({ label, value, icon, showSign = false, invertColors = false }: MetricItemProps) {
  const isPositive = value >= 0;
  const displayPositive = invertColors ? !isPositive : isPositive;
  
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center">
          {icon}
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-1">
        {showSign && value !== 0 && (
          displayPositive ? (
            <Icon icon={ArrowUpRight} size="xs" className="text-emerald-500" />
          ) : (
            <Icon icon={ArrowDownRight} size="xs" className="text-red-500" />
          )
        )}
        <span
          className={cn(
            "font-semibold",
            showSign && value !== 0 && (displayPositive ? "text-emerald-500" : "text-red-500")
          )}
        >
          {showSign && value > 0 ? "+" : ""}
          {formatCurrency(value)}
        </span>
      </div>
    </div>
  );
}

export function YtdSummaryCard({ data, className }: YtdSummaryCardProps) {
  // Check if we have any YTD data to display
  const hasData = useMemo(() => {
    return (
      data.net_deposits_ytd !== undefined ||
      data.withdrawals_ytd !== undefined ||
      data.total_income_ytd !== undefined ||
      data.total_fees !== undefined ||
      data.investment_gain_loss !== undefined
    );
  }, [data]);

  if (!hasData) {
    return null;
  }

  return (
    <Card variant="muted" effect="glass" className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Icon icon={Calendar} size="md" className="text-primary" />
          Year-to-Date Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border/50">
        {data.net_deposits_ytd !== undefined && (
          <MetricItem
            label="Net Deposits"
            value={data.net_deposits_ytd}
            icon={<Icon icon={Wallet} size="md" className="text-muted-foreground" />}
            showSign
          />
        )}
        
        {data.withdrawals_ytd !== undefined && (
          <MetricItem
            label="Withdrawals"
            value={-Math.abs(data.withdrawals_ytd)}
            icon={<Icon icon={ArrowDownRight} size="md" className="text-muted-foreground" />}
          />
        )}
        
        {data.total_income_ytd !== undefined && (
          <MetricItem
            label="Total Income"
            value={data.total_income_ytd}
            icon={<Icon icon={DollarSign} size="md" className="text-muted-foreground" />}
            showSign
          />
        )}
        
        {data.total_fees !== undefined && data.total_fees > 0 && (
          <MetricItem
            label="Fees Paid"
            value={-Math.abs(data.total_fees)}
            icon={<Icon icon={Receipt} size="md" className="text-muted-foreground" />}
            invertColors
          />
        )}
        
        {data.investment_gain_loss !== undefined && (
          <MetricItem
            label="Investment Gain/Loss"
            value={data.investment_gain_loss}
            icon={
              data.investment_gain_loss >= 0 ? (
                <Icon icon={TrendingUp} size="md" className="text-emerald-500" />
              ) : (
                <Icon icon={TrendingDown} size="md" className="text-red-500" />
              )
            }
            showSign
          />
        )}
      </CardContent>
    </Card>
  );
}

export default YtdSummaryCard;
