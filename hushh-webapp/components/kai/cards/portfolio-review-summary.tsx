import { TrendingDown, TrendingUp } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

interface PortfolioReviewSummaryProps {
  totalValue: number;
  unrealizedGainLoss: number;
  holdingCount: number;
  riskBucket: string;
  cashBalance: number;
}

function formatCurrencyCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

export function PortfolioReviewSummary({
  totalValue,
  unrealizedGainLoss,
  holdingCount,
  riskBucket,
  cashBalance,
}: PortfolioReviewSummaryProps) {
  return (
    <Card variant="none" preset="surface-feature" className="overflow-hidden">
      <CardContent className="relative p-5 space-y-5">
        <div className="text-left">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Total Portfolio Value
          </p>
          <p className="max-w-full text-[30px] font-semibold leading-tight tracking-tight tabular-nums break-words text-foreground">
            <span title={formatCurrency(totalValue)}>{formatCurrencyCompact(totalValue)}</span>
          </p>
          {unrealizedGainLoss !== 0 && (
            <div className="flex justify-start mt-3">
              <Badge className={cn(
                "font-bold py-1 px-3",
                unrealizedGainLoss >= 0
                  ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                  : "bg-red-500/10 text-red-500 border-red-500/20"
              )}>
                <Icon icon={unrealizedGainLoss >= 0 ? TrendingUp : TrendingDown} size={12} className="mr-1.5" aria-hidden="true" />
                <span title={formatCurrency(unrealizedGainLoss)}>
                  {formatCurrencyCompact(unrealizedGainLoss)} unrealized
                </span>
              </Badge>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 border-t border-primary/10 pt-6 sm:grid-cols-3">
          <div className="min-w-0 text-left pl-2 sm:pl-4">
            <p className="text-lg font-semibold sm:text-xl">{holdingCount}</p>
            <p className="text-xs font-medium text-muted-foreground">Assets</p>
          </div>
          <div className="min-w-0 flex flex-col items-center justify-center">
            <Badge variant="outline" className={cn(
              "font-semibold text-xs uppercase tracking-widest px-2",
              riskBucket === "aggressive"
                ? "app-critical-badge"
                : riskBucket === "moderate"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            )}>
              {riskBucket}
            </Badge>
            <p className="text-xs font-medium text-muted-foreground mt-1.5">Portfolio Risk</p>
          </div>
          <div className="min-w-0 text-right pr-2 sm:pr-4">
            <p className={cn(
              "max-w-full text-base font-semibold leading-none tracking-normal tabular-nums truncate sm:text-lg",
              cashBalance < 0 ? "text-red-500 dark:text-red-400" : "text-foreground"
            )}>
              <span title={formatCurrency(cashBalance)}>{formatCurrencyCompact(cashBalance)}</span>
            </p>
            <p className="text-xs font-medium text-muted-foreground mt-1.5">Cash</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
