"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

export interface HistoricalDataPoint {
  date: string;
  value: number;
}

interface PortfolioHistoryChartProps {
  data: HistoricalDataPoint[];
  height?: number;
  className?: string;
}

type RangeKey = "all" | "1y" | "3m" | "1m";

const RANGE_LABELS: Record<RangeKey, string> = {
  all: "All",
  "1y": "1Y",
  "3m": "3M",
  "1m": "1M",
};

function formatCurrency(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits:
      Math.abs(value) >= 1_000_000 ? 1 : maximumFractionDigits,
  }).format(value);
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function formatDateTick(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function availableRanges(data: HistoricalDataPoint[]): RangeKey[] {
  const first = new Date(data[0]?.date || "");
  const last = new Date(data.at(-1)?.date || "");
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()))
    return ["all"];
  const days = Math.max(0, (last.getTime() - first.getTime()) / 86_400_000);
  return [
    ...(days >= 30 ? (["1m"] as const) : []),
    ...(days >= 90 ? (["3m"] as const) : []),
    ...(days >= 365 ? (["1y"] as const) : []),
    "all",
  ];
}

function filterRange(
  data: HistoricalDataPoint[],
  range: RangeKey,
): HistoricalDataPoint[] {
  if (range === "all") return data;
  const last = new Date(data.at(-1)?.date || "");
  if (Number.isNaN(last.getTime())) return data;
  const days = range === "1m" ? 30 : range === "3m" ? 90 : 365;
  const lowerBound = new Date(last);
  lowerBound.setDate(lowerBound.getDate() - days);
  const filtered = data.filter((point) => {
    const date = new Date(point.date);
    return !Number.isNaN(date.getTime()) && date >= lowerBound;
  });
  return filtered.length >= 2 ? filtered : data;
}

/**
 * Renders only provider-backed historical points. It intentionally has no
 * statement-period fallback: a range line is evidence, not decoration.
 */
export function PortfolioHistoryChart({
  data,
  height = 256,
  className,
}: PortfolioHistoryChartProps) {
  const sanitizedData = useMemo(
    () =>
      data
        .filter((point) => point.date && Number.isFinite(point.value))
        .slice()
        .sort(
          (left, right) =>
            new Date(left.date).getTime() - new Date(right.date).getTime(),
        ),
    [data],
  );
  const ranges = useMemo(() => availableRanges(sanitizedData), [sanitizedData]);
  const [range, setRange] = useState<RangeKey>("all");
  const [selectedPoint, setSelectedPoint] =
    useState<HistoricalDataPoint | null>(null);
  const visibleData = useMemo(
    () => filterRange(sanitizedData, ranges.includes(range) ? range : "all"),
    [range, ranges, sanitizedData],
  );
  const first = visibleData[0] ?? null;
  const latest = visibleData.at(-1) ?? null;
  const change = first && latest ? latest.value - first.value : 0;
  const changePct =
    first && first.value !== 0 ? (change / first.value) * 100 : 0;
  const positive = change >= 0;
  const readout = selectedPoint || latest;
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      value: {
        label: "Portfolio value",
        color: positive ? "var(--chart-2)" : "var(--destructive)",
      },
    }),
    [positive],
  );

  if (visibleData.length < 2 || !latest) return null;

  const chartColor = positive ? "var(--chart-2)" : "var(--destructive)";

  return (
    <section
      className={cn("min-w-0", className)}
      aria-label="Portfolio performance"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Performance</p>
          <p
            className={cn(
              "mt-1 text-sm font-medium",
              positive
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {positive ? "+" : ""}
            {formatCurrency(change)} ({positive ? "+" : ""}
            {changePct.toFixed(2)}%)
          </p>
        </div>
        {ranges.length > 1 ? (
          <div
            className="flex rounded-full bg-muted p-1"
            aria-label="Performance range"
          >
            {ranges.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setRange(option);
                  setSelectedPoint(null);
                }}
                className={cn(
                  "min-h-8 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  range === option
                    ? "bg-background text-foreground shadow-[var(--shadow-xs)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={range === option}
              >
                {RANGE_LABELS[option]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-4 rounded-[var(--app-card-radius-compact)] bg-muted/40 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">
          {readout ? formatDate(readout.date) : "Latest value"}
        </p>
        <p className="mt-0.5 text-lg font-medium tabular-nums text-foreground">
          {readout ? formatCurrency(readout.value, 2) : "—"}
        </p>
      </div>

      <ChartContainer
        config={chartConfig}
        className="mt-3 w-full min-w-0"
        style={{ height }}
      >
        <AreaChart
          data={visibleData}
          accessibilityLayer
          margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
          onClick={(state) => {
            const payload = state.activePayload?.[0]?.payload as
              HistoricalDataPoint | undefined;
            if (payload) setSelectedPoint(payload);
          }}
        >
          <defs>
            <linearGradient
              id="portfolio-performance-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={chartColor} stopOpacity={0.3} />
              <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateTick}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={(value) => formatCurrency(Number(value))}
            tickLine={false}
            axisLine={false}
            width={58}
            domain={["dataMin * 0.985", "dataMax * 1.015"]}
          />
          <ChartTooltip
            cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "3 3" }}
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatDate(String(label))}
                formatter={(value) => formatCurrency(Number(value), 2)}
              />
            }
          />
          <Area
            dataKey="value"
            type="monotone"
            stroke={chartColor}
            strokeWidth={2.5}
            fill="url(#portfolio-performance-fill)"
            activeDot={{
              r: 5,
              fill: chartColor,
              stroke: "hsl(var(--background))",
              strokeWidth: 2,
            }}
            animationDuration={420}
          />
          {selectedPoint ? (
            <ReferenceDot
              x={selectedPoint.date}
              y={selectedPoint.value}
              r={5}
              fill={chartColor}
              stroke="hsl(var(--background))"
              strokeWidth={2}
            />
          ) : null}
        </AreaChart>
      </ChartContainer>
    </section>
  );
}

export default PortfolioHistoryChart;
