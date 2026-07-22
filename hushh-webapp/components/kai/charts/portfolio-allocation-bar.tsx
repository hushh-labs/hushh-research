"use client";

import { useMemo } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

import { ChartSurfaceCard } from "@/components/app-ui/surfaces";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

export interface PortfolioAllocationDatum {
  name: string;
  value: number;
}

interface PortfolioAllocationBarProps {
  data: PortfolioAllocationDatum[];
  selectedName?: string | null;
  onSelectionChange?: (name: string | null) => void;
  className?: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function toChartKey(name: string, index: number): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "allocation"}_${index}`;
}

/**
 * A real-data allocation read. The chart and the accessible row controls use
 * the same selection state so touch users never need hover to inspect a slice.
 */
export function PortfolioAllocationBar({
  data,
  selectedName = null,
  onSelectionChange,
  className,
}: PortfolioAllocationBarProps) {
  const { segments, total, chartConfig, chartRow } = useMemo(() => {
    const eligible = data.filter(
      (entry) => Number.isFinite(entry.value) && entry.value > 0,
    );
    const totalValue = eligible.reduce((sum, entry) => sum + entry.value, 0);
    const nextSegments = eligible.map((entry, index) => ({
      ...entry,
      key: toChartKey(entry.name, index),
      percent: totalValue > 0 ? (entry.value / totalValue) * 100 : 0,
    }));
    const nextConfig = Object.fromEntries(
      nextSegments.map((entry, index) => [
        entry.key,
        {
          label: entry.name,
          color: `var(--chart-${(index % 5) + 1})`,
        },
      ]),
    ) satisfies ChartConfig;
    const nextChartRow = nextSegments.reduce<Record<string, number | string>>(
      (row, entry) => ({
        ...row,
        [entry.key]: entry.value,
        label: "Portfolio",
      }),
      {},
    );

    return {
      segments: nextSegments,
      total: totalValue,
      chartConfig: nextConfig,
      chartRow: nextChartRow,
    };
  }, [data]);

  if (!segments.length) return null;

  return (
    <ChartSurfaceCard
      title="Allocation"
      description="Select a category to focus its holdings."
      className={cn("min-w-0", className)}
      contentClassName="space-y-4"
    >
      <ChartContainer config={chartConfig} className="h-[72px] w-full min-w-0">
        <BarChart
          data={[chartRow]}
          layout="vertical"
          margin={{ top: 8, right: 0, bottom: 8, left: 0 }}
        >
          <XAxis type="number" domain={[0, total]} hide />
          <YAxis type="category" dataKey="label" hide />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name) => {
                  const label =
                    chartConfig[String(name)]?.label || String(name);
                  const amount = Number(value || 0);
                  return (
                    <div className="flex min-w-[10rem] items-baseline justify-between gap-4">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(amount)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {segments.map((segment) => (
            <Bar
              key={segment.key}
              dataKey={segment.key}
              stackId="allocation"
              fill={`var(--color-${segment.key})`}
              radius={4}
              maxBarSize={28}
              cursor="pointer"
              fillOpacity={
                !selectedName || selectedName === segment.name ? 1 : 0.26
              }
              onClick={() =>
                onSelectionChange?.(
                  selectedName === segment.name ? null : segment.name,
                )
              }
            />
          ))}
        </BarChart>
      </ChartContainer>

      <div
        className="flex flex-wrap gap-x-4 gap-y-2"
        aria-label="Portfolio allocation categories"
      >
        {segments.map((segment) => {
          const selected = selectedName === segment.name;
          return (
            <button
              key={segment.key}
              type="button"
              onClick={() =>
                onSelectionChange?.(selected ? null : segment.name)
              }
              className={cn(
                "inline-flex min-h-9 items-center gap-2 rounded-full px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-accent-surface text-accent-strong"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={selected}
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: `var(--color-${segment.key})` }}
              />
              <span className="font-medium text-foreground">
                {segment.name}
              </span>
              <span>{segment.percent.toFixed(0)}%</span>
            </button>
          );
        })}
      </div>
    </ChartSurfaceCard>
  );
}
