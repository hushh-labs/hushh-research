"use client";

import { PriceHistoryChart } from "@/components/kai/charts/price-history-chart";
import type { PriceHistoryPoint } from "@/lib/kai/price-history";
export type HistoricalDataPoint = PriceHistoryPoint;

export function PortfolioHistoryChart({ data, height = 248, className, currency, formatValue }: {
  data: HistoricalDataPoint[]; height?: number; className?: string;
  currency?: string; formatValue?: (value: number, compact: boolean) => string;
}) {
  return <div className={className}><PriceHistoryChart data={data} height={height} label="Portfolio performance"
    currency={currency} formatValue={formatValue} /></div>;
}
export default PortfolioHistoryChart;
