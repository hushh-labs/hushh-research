"use client";

import { useMemo } from "react";
import { BarChart3 } from "lucide-react";
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

interface ConcentrationDatum {
  symbol: string;
  name: string;
  marketValue: number;
  weightPct: number;
}

interface HoldingsConcentrationChartProps {
  data: ConcentrationDatum[];
  className?: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function HoldingsConcentrationChart({
  data,
  className,
}: HoldingsConcentrationChartProps) {
  const chartData = data.slice(0, 8);
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      weightPct: {
        label: "Weight %",
        color: "var(--chart-3)",
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
          <BarChart3 className="h-4 w-4 text-primary" />
          Holdings Concentration
        </span>
      }
      className={className}
      contentClassName="space-y-0"
    >
      <SurfaceInset className="min-w-0 overflow-hidden">
        <ChartContainer config={chartConfig} className="h-[192px] w-full min-w-0 sm:h-[204px]">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 6, right: 46, left: 6, bottom: 0 }}
            barCategoryGap="24%"
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="hsl(var(--border))"
              strokeOpacity={0.9}
            />
            <XAxis
              type="number"
              tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10 }}
            />
            <YAxis
              type="category"
              dataKey="symbol"
              width={52}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10 }}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(_value, _name, item) => {
                    const payload = item.payload as ConcentrationDatum;
                    return (
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Holdings Concentration
                        </span>
                        <span className="text-sm font-semibold">{payload.symbol}</span>
                        <span className="text-xs text-muted-foreground truncate">{payload.name}</span>
                        <span className="text-sm font-medium">
                          {payload.weightPct.toFixed(2)}% • {formatCurrency(payload.marketValue)}
                        </span>
                      </div>
                    );
                  }}
                />
              }
            />
            <Bar dataKey="weightPct" radius={[0, 6, 6, 0]} maxBarSize={16}>
              <LabelList
                dataKey="weightPct"
                position="right"
                className="fill-foreground"
                fontSize={10}
                formatter={(value: number) => `${Number(value).toFixed(1)}%`}
              />
              {chartData.map((entry, index) => (
                <Cell
                  key={`${entry.symbol}-${index}`}
                  fill={`var(--chart-${(index % 5) + 1})`}
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </SurfaceInset>
    </ChartSurfaceCard>
  );
}
