"use client";

import { useMemo } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

import { AllocationSection } from "./allocation-section";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
  CHART_ANIMATION_ACTIVE,
  CHART_TOOLTIP_TRIGGER,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { allocationColor } from "@/lib/kai/allocation-colors";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

export interface PortfolioAllocationDatum {
  name: string;
  value: number;
}

interface PortfolioAllocationBarProps {
  data: PortfolioAllocationDatum[];
  totalValue?: number;
  selectedName?: string | null;
  onSelectionChange?: (name: string | null) => void;
  className?: string;
  embedded?: boolean;
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
  totalValue,
  selectedName = null,
  onSelectionChange,
  className,
  embedded,
}: PortfolioAllocationBarProps) {
  const { segments, total, chartConfig, chartRow } = useMemo(() => {
    const eligible = data.filter(
      (entry) => Number.isFinite(entry.value) && entry.value > 0,
    );
    const mappedValue = eligible.reduce((sum, entry) => sum + entry.value, 0);
    const nextSegments = eligible.map((entry, index) => ({
      ...entry,
      key: toChartKey(entry.name, index),
      percent: (totalValue ?? mappedValue) > 0 ? (entry.value / (totalValue ?? mappedValue)) * 100 : 0,
    }));
    const nextConfig = Object.fromEntries(
      nextSegments.map((entry) => [
        entry.key,
        {
          label: entry.name,
          color: allocationColor(entry.name),
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
      total: mappedValue,
      chartConfig: nextConfig,
      chartRow: nextChartRow,
    };
  }, [data, totalValue]);

  if (!segments.length) return null;

  return (
    <AllocationSection
      title="Asset mix"
      description="Select a category to focus its holdings."
      className={cn("min-w-0", className)}
      embedded={embedded}
    >
      <ChartContainer config={chartConfig} className="h-8 w-full min-w-0">
        <BarChart
          data={[chartRow]}
          layout="vertical"
          margin={{ top: 8, right: 0, bottom: 8, left: 0 }}
        >
          <XAxis type="number" domain={[0, totalValue ?? total]} hide />
          <YAxis type="category" dataKey="label" hide />
          <ChartTooltip trigger={CHART_TOOLTIP_TRIGGER}
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
            <Bar isAnimationActive={CHART_ANIMATION_ACTIVE}
              key={segment.key}
              dataKey={segment.key}
              stackId="allocation"
              fill={`var(--color-${segment.key})`}
              radius={4}
              maxBarSize={8}
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

      <div className={styles.allocationRows} aria-label="Portfolio allocation categories">
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
                styles.allocationRow,
                styles.interactiveRow,
                "relative isolate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "bg-accent-surface text-accent-strong" : "hover:text-foreground",
              )}
              data-finance-selected={selected || undefined}
              aria-pressed={selected}
            >
              <span
                aria-hidden="true"
                className={styles.allocationDot}
                style={{ backgroundColor: allocationColor(segment.name) }}
              />
              <span className={styles.allocationText}>
                <span className={styles.allocationName}>{segment.name}</span>
              </span>
              <span className={styles.allocationAmount}>
                <span>{formatCurrency(segment.value)}</span>
                <span className={styles.allocationMeta}>{segment.percent.toFixed(1)}%</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className={styles.allocationMeta}>Percentages use {formatCurrency(totalValue ?? total)} total portfolio value.</p>
    </AllocationSection>
  );
}
