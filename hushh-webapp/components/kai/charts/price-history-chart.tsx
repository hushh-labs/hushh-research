"use client";

import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, CHART_ANIMATION_ACTIVE, CHART_TOOLTIP_TRIGGER } from "@/components/ui/chart";
import { normalizePriceHistory, priceHistoryRanges, slicePriceHistory, PRICE_RANGE_LABELS, type PriceHistoryPoint, type PriceRange } from "@/lib/kai/price-history";
import { cn } from "@/lib/utils";

const money = (value: number, compact = false) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2,
}).format(value);
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: date.length === 10 ? "UTC" : "America/New_York" }).format(new Date(date));

/** Shared, non-smoothed area chart: never manufactures candles or a trend. */
export function PriceHistoryChart({ data, label, height = 248 }: {
  data: PriceHistoryPoint[]; label: string; height?: number;
}) {
  const fillId = `price-${useId().replace(/:/g, "")}`;
  const points = useMemo(() => normalizePriceHistory(data), [data]);
  const ranges = useMemo<PriceRange[]>(() => [...priceHistoryRanges(points), "all"], [points]);
  const [range, setRange] = useState<PriceRange>("all");
  const selectedRange = ranges.includes(range) ? range : "all";
  const visible = useMemo(() => slicePriceHistory(points, selectedRange), [points, selectedRange]);
  const first = visible[0];
  const last = visible.at(-1);
  const delta = first && last ? last.value - first.value : 0;
  const positive = delta >= 0;
  const color = positive ? "var(--finance-positive, var(--app-success-deep))" : "var(--finance-negative, var(--app-destructive-deep))";
  if (visible.length < 2 || !first || !last) return <p className="py-8 text-sm text-muted-foreground">Price history is unavailable for this source.</p>;

  return <section aria-label={label} className="min-w-0" data-no-route-swipe>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p className="text-sm font-semibold">{label}</p>
      <p className={cn("text-sm font-medium tabular-nums", positive ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
        {positive ? "+" : "−"}{money(Math.abs(delta))}{first.value > 0 ? ` (${positive ? "+" : ""}${(delta / first.value * 100).toFixed(2)}%)` : ""}
      </p>
    </div>
    <div className="my-3 flex items-center justify-between gap-1 border-y border-border/60 py-1" role="group" aria-label={`${label} range`}>
      {ranges.map(option => <button key={option} type="button" aria-pressed={selectedRange === option}
        onClick={() => setRange(option)} className={cn("min-h-11 min-w-11 rounded-full px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selectedRange === option ? "bg-accent-surface text-accent-strong" : "text-muted-foreground hover:bg-muted")}>{PRICE_RANGE_LABELS[option]}</button>)}
    </div>
    <ChartContainer config={{ value: { label: "USD", color } }} className="aspect-auto w-full" style={{ height }}>
      <AreaChart data={visible} accessibilityLayer margin={{ top: 12, right: 0, left: 2, bottom: 0 }}>
        <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.24} /><stop offset="100%" stopColor={color} stopOpacity={0.01} /></linearGradient></defs>
        <CartesianGrid vertical={false} strokeDasharray="3 4" />
        <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={36} tickMargin={10}
          tickFormatter={date => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: String(date).length === 10 ? "UTC" : "America/New_York" }).format(new Date(date))} />
        <YAxis orientation="right" tickLine={false} axisLine={false} width={62} tickCount={4}
          domain={([min, max]: [number, number]) => { const padding = Math.max((max - min) * 0.12, max * 0.001); return [Math.max(0, min - padding), max + padding]; }}
          tickFormatter={value => money(Number(value), Number(value) >= 10_000)} />
        <ReferenceLine y={first.value} stroke="var(--muted-foreground)" strokeDasharray="3 4" strokeOpacity={0.5} />
        <ChartTooltip trigger={CHART_TOOLTIP_TRIGGER} cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 4" }}
          content={<ChartTooltipContent labelFormatter={date => dateLabel(String(date))} formatter={value => money(Number(value))} />} />
        <Area dataKey="value" type="linear" stroke={color} strokeWidth={2} fill={`url(#${fillId})`} isAnimationActive={CHART_ANIMATION_ACTIVE} animationDuration={350}
          activeDot={{ r: 4, stroke: "var(--background)", strokeWidth: 2 }} />
      </AreaChart>
    </ChartContainer>
    <p className="mt-3 text-xs leading-[18px] text-muted-foreground">{dateLabel(first.date)} – {dateLabel(last.date)} · USD · Tap a point or use arrow keys to inspect</p>
  </section>;
}
