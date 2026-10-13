"use client";

import { useMemo } from "react";
import { TrendingUpDown } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts";

import {
  ChartSurfaceCard,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

interface GainLossBandDatum {
  band: string;
  count: number;
}

interface GainLossDistributionChartProps {
  data: GainLossBandDatum[];
  className?: string;
}

function bandColor(band: string): string {
  if (band.includes("< -10") || band.includes("-10% to -2%")) {
    return "var(--destructive)";
  }
  if (band.includes("-2% to +2%")) {
    return "var(--chart-4)";
  }
  return "var(--chart-2)";
}

function compactBandLabel(band: string): string {
  return band
    .replace(" to ", "→")
    .replace("%", "%")
    .replace(" ", "");
}

export function GainLossDistributionChart({
  data,
  className,
}: GainLossDistributionChartProps) {
  const chartData = data.filter((row) => row.count > 0);
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      count: {
        label: "Holdings",
        color: "var(--chart-2)",
      },
    }),
    []
  );

  if (chartData.length === 0) {
    return null;
  }

  return (
    <ChartSurfaceCard
      title={
        <span className="flex items-center gap-2">
          <TrendingUpDown className="h-4 w-4 text-primary" />
          Gain/Loss Distribution
        </span>
      }
      className={className}
      contentClassName="space-y-0"
    >
      <SurfaceInset className="min-w-0 overflow-hidden">
        <ChartContainer config={chartConfig} className="h-[192px] w-full min-w-0">
          <BarChart data={chartData} margin={{ top: 22, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="hsl(var(--foreground) / 0.22)"
              strokeOpacity={0.55}
            />
            <XAxis
              dataKey="band"
              tickFormatter={(value) => compactBandLabel(String(value))}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              interval={0}
              tick={{ fontSize: 10, fill: "hsl(var(--foreground) / 0.72)" }}
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "hsl(var(--foreground) / 0.72)" }}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  hideIndicator
                  hideLabel
                  formatter={(value, _name, item) => {
                    const count = typeof value === "number" ? value : Number(value || 0);
                    const payload = item?.payload as GainLossBandDatum | undefined;
                    const suffix = count === 1 ? "" : "s";
                    const label = payload?.band ? `${payload.band}: ` : "";
                    return (
                      <span className="text-sm text-muted-foreground">
                        {label}
                        {count} holding{suffix}
                      </span>
                    );
                  }}
                />
              }
            />
            <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={28}>
              <LabelList
                dataKey="count"
                position="top"
                offset={8}
                className="fill-foreground"
                fontSize={10}
                formatter={(value: number) => Number(value).toFixed(0)}
              />
              {chartData.map((entry) => (
                <Cell key={entry.band} fill={bandColor(entry.band)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </SurfaceInset>
    </ChartSurfaceCard>
  );
}
