import { formatCurrency } from "@/lib/kai/market-value-format";
import { cn } from "@/lib/utils";
import type { HoldingMobileCardViewModel } from "./holding-mobile-card";

import { useMarketCurrency } from "@/lib/kai/use-market-currency";
export function HoldingGainLoss({ holding, className, showPercentage = false }: {
  holding: HoldingMobileCardViewModel;
  className?: string;
  showPercentage?: boolean;
}) {
  useMarketCurrency();
  const { gainLossValue, gainLossPct, costBasis, currency, isCash, pendingDelete } = holding;
  const gain = gainLossValue ?? gainLossPct;
  const tone = pendingDelete || gain === null || gain === 0 ? "text-muted-foreground"
    : gain > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const amount = gainLossValue === null ? null
    : `${gainLossValue > 0 ? "+" : gainLossValue < 0 ? "−" : ""}${formatCurrency(Math.abs(gainLossValue), currency)}`;
  const percent = gainLossPct === null ? null : `${gainLossPct > 0 ? "+" : ""}${gainLossPct.toFixed(2)}%`;
  const value = amount && percent && showPercentage ? `${amount} · ${percent}` : amount ?? percent;

  const missingLabel = costBasis == null ? "Cost basis missing" : "Market value missing";
  return <span className={cn(tone, className)}>
    {value ?? (isCash ? "—" : missingLabel)}
  </span>;
}
