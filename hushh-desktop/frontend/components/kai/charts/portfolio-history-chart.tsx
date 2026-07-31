// components/kai/charts/portfolio-history-chart.tsx

/**
 * Portfolio History Chart - Real data visualization
 * 
 * Features:
 * - Displays actual historical portfolio values from brokerage statements
 * - Uses shadcn ChartContainer for proper dark mode support
 * - Graceful fallback to period summary when no historical data
 * - Responsive and mobile-friendly
 */

"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { TrendingUp, TrendingDown, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

// =============================================================================
// TYPES
// =============================================================================

export interface HistoricalDataPoint {
  date: string;
  value: number;
}

interface PortfolioHistoryChartProps {
  data?: HistoricalDataPoint[];
  beginningValue?: number;
  endingValue?: number;
  statementPeriod?: string;
  height?: number;
  className?: string;
  /** When true, renders without card wrapper for embedding */
  inline?: boolean;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatCurrency(value: number, decimals: number = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatAxisValue(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}k`;
  }
  return `$${value.toFixed(0)}`;
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatDateTick(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parsed);
  }
  return raw.length > 10 ? `${raw.slice(0, 10)}…` : raw;
}

// =============================================================================
// PERIOD SUMMARY FALLBACK
// =============================================================================

interface PeriodSummaryProps {
  beginningValue: number;
  endingValue: number;
  statementPeriod?: string;
}

function PeriodSummaryFallback({ 
  beginningValue, 
  endingValue, 
  statementPeriod 
}: PeriodSummaryProps) {
  const changeInValue = endingValue - beginningValue;
  const changePercent = beginningValue > 0 
    ? ((changeInValue / beginningValue) * 100) 
    : 0;
  const isPositive = changeInValue >= 0;

  return (
    <div className="space-y-4">
      {statementPeriod && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon icon={Calendar} size="sm" />
          <span>{statementPeriod}</span>
        </div>
      )}
      
      <div className="grid grid-cols-2 gap-4">
        <div className="text-center p-4 rounded-lg bg-muted/50">
          <p className="text-xs text-muted-foreground mb-1">Beginning Value</p>
          <p className="text-lg font-semibold">{formatCurrency(beginningValue)}</p>
        </div>
        <div className="text-center p-4 rounded-lg bg-muted/50">
          <p className="text-xs text-muted-foreground mb-1">Ending Value</p>
          <p className="text-lg font-semibold">{formatCurrency(endingValue)}</p>
        </div>
      </div>
      
      <div className={cn(
        "flex items-center justify-center gap-2 py-3 rounded-lg",
        isPositive ? "bg-emerald-500/10" : "bg-red-500/10"
      )}>
        <Icon
          icon={isPositive ? TrendingUp : TrendingDown}
          size="md"
          className={isPositive ? "text-emerald-500" : "text-red-500"}
        />
        <span className={cn(
          "font-medium",
          isPositive ? "text-emerald-500" : "text-red-500"
        )}>
          {formatCurrency(Math.abs(changeInValue))} ({formatPercent(changePercent)})
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function PortfolioHistoryChart({
  data,
  beginningValue = 0,
  endingValue = 0,
  statementPeriod,
  height = 200,
  className,
  inline = false,
}: PortfolioHistoryChartProps) {
  // Determine if we have enough data for a chart
  const hasChartData = data && data.length >= 2;
  
  // Calculate if performance is positive
  const isPositive = useMemo(() => {
    if (hasChartData && data && data.length >= 2) {
      const lastItem = data[data.length - 1];
      const firstItem = data[0];
      if (lastItem && firstItem) {
        return lastItem.value >= firstItem.value;
      }
    }
    return endingValue >= beginningValue;
  }, [data, hasChartData, beginningValue, endingValue]);

  // Chart config for shadcn ChartContainer - uses CSS variables for theme support
  const chartConfig = useMemo<ChartConfig>(() => ({
    value: {
      label: "Portfolio Value",
      color: isPositive ? "var(--chart-2)" : "var(--destructive)",
    },
  }), [isPositive]);

  // Use CSS variables for theme-aware colors
  const chartColor = isPositive ? "var(--chart-2)" : "var(--destructive)";

  // If no historical data, show period summary fallback (only when not inline)
  if (!hasChartData) {
    if (!inline && (beginningValue > 0 || endingValue > 0)) {
      return (
        <Card variant="none" effect="glass" showRipple={false} className={className}>
          <CardContent className="p-4">
            <PeriodSummaryFallback
              beginningValue={beginningValue}
              endingValue={endingValue}
              statementPeriod={statementPeriod}
            />
          </CardContent>
        </Card>
      );
    }
    return null;
  }

  // Chart content (shared between inline and card modes)
  const chartContent = (
    <>
      {!inline && statementPeriod && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mb-4">
          <Icon icon={Calendar} size="sm" />
          <span>{statementPeriod}</span>
        </div>
      )}
      
      <ChartContainer 
        config={chartConfig} 
        className="w-full min-w-0 overflow-hidden"
        style={{ height }}
      >
        <AreaChart
          data={data}
          accessibilityLayer
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            strokeOpacity={0.9}
          />
          <XAxis 
            dataKey="date" 
            tickFormatter={formatDateTick}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval="preserveStartEnd"
            minTickGap={26}
            tick={{ fontSize: 10 }}
          />
          <YAxis 
            tickLine={false}
            axisLine={false}
            tickFormatter={formatAxisValue}
            width={55}
            domain={["dataMin * 0.95", "dataMax * 1.05"]}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent 
                formatter={(value) => formatCurrency(value as number)}
              />
            }
          />
          <defs>
            <linearGradient id="portfolioHistoryGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            dataKey="value"
            type="monotone"
            fill="url(#portfolioHistoryGradient)"
            stroke={chartColor}
            strokeWidth={3}
            activeDot={{
              r: 6,
              style: { fill: chartColor, opacity: 0.9, stroke: "var(--background)", strokeWidth: 2 }
            }}
            animationDuration={1500}
            animationEasing="ease-in-out"
          />
        </AreaChart>
      </ChartContainer>
      
      {!inline && (
        <p className="text-xs text-muted-foreground text-center mt-2">
          Portfolio Value Over Time
        </p>
      )}
    </>
  );

  // Inline mode: return just the chart content
  if (inline) {
    return <div className={className}>{chartContent}</div>;
  }

  // Card mode: wrap in card
  return (
    <Card variant="none" effect="glass" showRipple={false} className={className}>
      <CardContent className="p-4">
        {chartContent}
      </CardContent>
    </Card>
  );
}

export default PortfolioHistoryChart;
