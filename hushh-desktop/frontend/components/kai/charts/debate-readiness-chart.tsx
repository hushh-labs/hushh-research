"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface DebateReadinessDatum {
  key: string;
  label: string;
  value: number;
}

interface DebateReadinessChartProps {
  data: DebateReadinessDatum[];
  className?: string;
}

const READINESS_BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
];

const CHART_CONFIG = {
  coverage: {
    label: "Coverage",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

function clampCoverage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function DebateReadinessChart({ data, className }: DebateReadinessChartProps) {
  if (data.length === 0) return null;

  return (
    <ChartContainer
      config={CHART_CONFIG}
      className={className ?? "h-[236px] w-full rounded-xl border border-border/60 bg-background/70 p-2"}
    >
      <BarChart
        accessibilityLayer
        data={data}
        margin={{ top: 24, right: 8, left: 6, bottom: 4 }}
        barSize={28}
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
          tick={{ fontSize: 11 }}
        />
        <YAxis
          domain={[0, 100]}
          tickCount={5}
          tickFormatter={(value) => `${value}%`}
          tickLine={false}
          axisLine={false}
          width={42}
          tick={{ fontSize: 11 }}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value) => `${clampCoverage(Number(value)).toFixed(0)}%`}
            />
          }
        />
        <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={30}>
          <LabelList
            dataKey="value"
            position="top"
            offset={8}
            className="fill-foreground"
            fontSize={10}
            formatter={(value: number) => `${clampCoverage(Number(value)).toFixed(0)}%`}
          />
          {data.map((entry, index) => (
            <Cell
              key={entry.key}
              fill={READINESS_BAR_COLORS[index % READINESS_BAR_COLORS.length] ?? "var(--chart-1)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
