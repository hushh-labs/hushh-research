"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  ChartSurfaceCard,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";

export interface StatementCashflowDatum {
  key: string;
  label: string;
  value: number;
  tone: "positive" | "negative" | "neutral";
}

interface StatementCashflowChartProps {
  data: StatementCashflowDatum[];
  className?: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatAxisValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

function barColorForTone(tone: StatementCashflowDatum["tone"]): string {
  if (tone === "positive") return "var(--chart-2)";
  if (tone === "negative") return "var(--destructive)";
  return "var(--chart-1)";
}

export function StatementCashflowChart({
  data,
  className,
}: StatementCashflowChartProps) {
  const rows = useMemo(
    () => data.filter((row) => Number.isFinite(row.value)),
    [data]
  );

  if (rows.length < 2) {
    return null;
  }

  const chartConfig: ChartConfig = {
    value: {
      label: "Amount",
      color: "var(--chart-1)",
    },
  };

  return (
    <ChartSurfaceCard
      title="Statement Cashflow Signals"
      className={cn("min-w-0", className)}
      contentClassName="space-y-0"
    >
      <SurfaceInset className="overflow-hidden">
        <ChartContainer config={chartConfig} className="h-[214px] w-full">
          <BarChart
            accessibilityLayer
            data={rows}
            margin={{ top: 24, right: 8, left: 0, bottom: 0 }}
            barSize={24}
          >
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="hsl(var(--border))"
              strokeOpacity={0.95}
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tick={{ fontSize: 10 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxisValue}
              width={58}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  formatter={(value) => formatCurrency(value as number)}
                />
              }
            />
            <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={26}>
              <LabelList
                dataKey="value"
                position="top"
                offset={8}
                className="fill-foreground"
                fontSize={10}
                formatter={(value: number) => formatAxisValue(Number(value))}
              />
              {rows.map((row) => (
                <Cell key={row.key} fill={barColorForTone(row.tone)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </SurfaceInset>
    </ChartSurfaceCard>
  );
}
