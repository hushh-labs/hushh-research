"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ChartContainer, ChartTooltip, ChartTooltipContent, CHART_TOOLTIP_TRIGGER } from "@/components/ui/chart";
import type { MarketOverviewMetric } from "@/components/kai/cards/market-overview-grid";
import marketStyles from "@/components/kai/shared/market-briefing.module.css";
import { cn } from "@/lib/utils";

function returnColor(tone: MarketOverviewMetric["tone"] | undefined) {
  return tone === "positive"
    ? "text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]"
    : tone === "negative"
      ? "text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]"
      : "text-muted-foreground";
}

const indexLevel = (value: number) => new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value);

export function IndexSparkline({ tone, series, height = 40, expanded = false }: {
  tone: MarketOverviewMetric["tone"] | undefined;
  series?: number[] | null;
  height?: number;
  expanded?: boolean;
}) {
  const fillId = `index-${useId().replace(/:/g, "")}`;
  const first = series?.[0];
  if (!series || series.length < 2 || first === undefined) {
    return <svg className="mt-2 block w-full text-muted-foreground opacity-50" viewBox="0 0 100 20"
      preserveAspectRatio="none" aria-hidden="true" style={{ height }}>
      <path d="M0 10 L100 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 4" strokeLinecap="round" />
    </svg>;
  }

  return <div className={cn("mt-2 w-full", returnColor(tone))} aria-hidden={expanded ? undefined : true}
    role={expanded ? "region" : undefined} aria-label={expanded ? "Intraday index history" : undefined}
    data-no-route-swipe={expanded ? true : undefined} data-index-chart-tone={tone}>
    <ChartContainer config={{ value: { label: "Index level", color: "currentColor" } }}
      className="aspect-auto w-full" style={{ height }}>
      <AreaChart data={series.map((value, index) => ({ index, value }))} accessibilityLayer={expanded}
        margin={{ top: 6, right: 2, left: 2, bottom: 2 }}>
        <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient></defs>
        {expanded ? <CartesianGrid vertical={false} strokeOpacity={0.3} /> : null}
        <XAxis dataKey="index" hide />
        <YAxis hide={!expanded} orientation="right" width={expanded ? 62 : 0} tickCount={4} tickLine={false} axisLine={false}
          tickFormatter={value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value))}
          domain={([min, max]: [number, number]) => {
            const padding = Math.max((max - min) * 0.12, max * 0.0001);
            return [Math.max(0, min - padding), max + padding];
          }} />
        <ReferenceLine y={first} stroke="currentColor" strokeOpacity={0.45} strokeDasharray="3 4" />
        {expanded ? <ChartTooltip trigger={CHART_TOOLTIP_TRIGGER}
          cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 4" }}
          content={<ChartTooltipContent hideIndicator labelFormatter={index => `Observed point ${Number(index) + 1}`}
            formatter={value => `${indexLevel(Number(value))} points`} />} /> : null}
        <Area type="linear" dataKey="value" stroke="currentColor" strokeWidth={2} fill={`url(#${fillId})`}
          fillOpacity={1} dot={false} activeDot={expanded ? { r: 3, stroke: "var(--background)", strokeWidth: 2 } : false} isAnimationActive={false} />
      </AreaChart>
    </ChartContainer>
    {expanded ? <p className="mt-2 text-xs leading-[18px] text-muted-foreground">
      Guide: first observed level {indexLevel(first)} points · Tap a point or use arrow keys to inspect
    </p> : null}
  </div>;
}

export function MarketIndexDetailSurface({ metric, open, onOpenChange }: {
  metric: MarketOverviewMetric | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = metric?.detailPanel;
  if (!metric || !detail) return null;

  return <KaiControlSurface open={open} onOpenChange={onOpenChange}
    title={detail.title} description={detail.summary} headerTextOverflow="wrap"
    surfaceClassName={cn(marketStyles.typography, marketStyles.indexDetailSurface)}
    contentClassName="sm:!max-w-[min(36rem,calc(100vw-5rem))] lg:!max-w-[min(38rem,calc(100vw-8rem))]"
    bodyClassName="px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 sm:px-6 sm:pt-5">
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Index level · points</p>
          {detail.statusLabel ? <span className="text-xs text-muted-foreground">{detail.statusLabel}</span> : null}
        </div>
        <p className={marketStyles.indexDetailValue}>{detail.value || metric.value}</p>
        <p className={cn("mt-1 text-sm font-semibold tabular-nums", returnColor(metric.tone))}>
          {detail.delta || metric.delta} <span className="ml-1 text-xs font-normal text-muted-foreground">1 day</span>
        </p>
      </div>
      {metric.sparkline && metric.sparkline.length >= 2 ? <div>
        <p className="text-xs text-muted-foreground">Intraday · at quote time</p>
        <IndexSparkline tone={metric.tone} series={metric.sparkline} height={200} expanded />
      </div> : null}
      {detail.facts?.length ? <dl className="divide-y divide-border/60 border-y border-border/60">
        {detail.facts.map((fact) => <div key={fact.label} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-4 py-3 text-sm leading-5">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 text-right font-medium text-foreground [overflow-wrap:anywhere]">{fact.value}</dd>
        </div>)}
      </dl> : null}
      {detail.sections?.map((section) => <section key={section.title} className="space-y-1.5">
        <h3 className={cn(marketStyles.indexDetailSectionTitle, "text-sm font-semibold leading-5 text-foreground")}>{section.title}</h3>
        {[...section.lines, ...(section.items ?? [])].map((line) => <p key={line} className="text-sm leading-[22px] text-muted-foreground">{line}</p>)}
      </section>)}
    </div>
  </KaiControlSurface>;
}
