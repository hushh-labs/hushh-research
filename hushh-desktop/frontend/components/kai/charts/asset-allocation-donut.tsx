// components/kai/charts/asset-allocation-donut.tsx

/**
 * Asset Allocation Donut Chart
 * 
 * Features:
 * - Donut chart showing portfolio allocation
 * - Interactive segments with hover effects
 * - Center label using Recharts Label component (proper z-index)
 * - Responsive design with shadcn ChartContainer
 * - Theme-aware colors from design system
 */

"use client";

import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Label,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

interface AllocationData {
  name: string;
  value: number;
  color: string;
  percent?: number;
}

interface AssetAllocationDonutProps {
  data: AllocationData[];
  height?: number;
  showLegend?: boolean;
  className?: string;
}

// Distinct palette tuned for adjacent-segment contrast.
const CHART_COLORS = [
  "#2563eb",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
];

// Fallback colors for specific asset types
const DEFAULT_COLORS: Record<string, string> = {
  cash: "#0ea5e9",
  equities: "#2563eb",
  bonds: "#f59e0b",
  etf: "#14b8a6",
  mutual_funds: "#8b5cf6",
  other: "#94a3b8",
};

function formatCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(2)}K`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

export function AssetAllocationDonut({
  data,
  height = 200,
  showLegend = true,
  className,
}: AssetAllocationDonutProps) {
  // Calculate total and percentages
  const { chartData, total } = useMemo(() => {
    const totalValue = data.reduce((sum, item) => sum + item.value, 0);

    const getStableColor = (name: string) => {
      const defaultColor = DEFAULT_COLORS[name.toLowerCase()];
      if (defaultColor) return defaultColor;
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      return CHART_COLORS[Math.abs(hash) % CHART_COLORS.length];
    };

    const processedData = data
      .filter(item => item.value > 0)
      .map((item) => ({
        ...item,
        percent: totalValue > 0 ? (item.value / totalValue) * 100 : 0,
        // Use provided color, fallback to asset type color, then to stable hashed color
        color: item.color || getStableColor(item.name),
      }));
    return { chartData: processedData, total: totalValue };
  }, [data]);

  // Chart config for shadcn ChartContainer
  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    chartData.forEach((item) => {
      config[item.name] = {
        label: item.name,
        color: item.color,
      };
    });
    return config;
  }, [chartData]);

  if (chartData.length === 0) {
    return (
      <div className={cn("flex items-center justify-center", className)} style={{ height }}>
        <p className="text-sm text-muted-foreground">No allocation data</p>
      </div>
    );
  }

  return (
    <div className={cn("w-full min-w-0 overflow-hidden", className)}>
      <ChartContainer config={chartConfig} className="mx-auto w-full min-w-0" style={{ height }}>
        <PieChart>
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name, item) => {
                  const payload = item.payload as AllocationData & { percent: number };
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="font-semibold text-sm">{payload.name}</span>
                      <span className="text-foreground text-base font-bold">{formatCurrency(payload.value)}</span>
                      <span className="text-muted-foreground text-xs">{formatPercent(payload.percent)} of portfolio</span>
                    </div>
                  );
                }}
              />
            }
          />
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius="55%"
            outerRadius="85%"
            paddingAngle={2}
            dataKey="value"
            nameKey="name"
            strokeWidth={2}
            animationDuration={800}
            animationEasing="ease-out"
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.color}
                stroke="transparent"
              />
            ))}
            <Label
              content={({ viewBox }) => {
                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                  return (
                    <text
                      x={viewBox.cx}
                      y={viewBox.cy}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      <tspan
                        x={viewBox.cx}
                        y={viewBox.cy}
                        className="fill-foreground text-lg font-bold"
                      >
                        {formatCurrency(total)}
                      </tspan>
                      <tspan
                        x={viewBox.cx}
                        y={(viewBox.cy || 0) + 18}
                        className="fill-muted-foreground text-xs"
                      >
                        Total
                      </tspan>
                    </text>
                  );
                }
                return null;
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>

      {/* Legend - always visible values for mobile/non-hover contexts */}
      {showLegend && (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:flex sm:flex-wrap sm:justify-center sm:gap-4">
          {chartData.map((item) => (
            <div
              key={item.name}
              className="flex min-w-0 items-center gap-2 text-xs sm:text-sm"
            >
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <div className="min-w-0">
                <p className="truncate text-foreground">{item.name}</p>
                <p className="text-[11px] font-medium text-foreground/80">
                  {formatCurrency(item.value)} ({formatPercent(item.percent || 0)})
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AssetAllocationDonut;
