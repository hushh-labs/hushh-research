"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { CHART_RESIZE_DEBOUNCE_MS } from "@/components/ui/chart";
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

export function IndexSparkline({ tone, series, height = 20 }: {
  tone: MarketOverviewMetric["tone"] | undefined;
  series?: number[] | null;
  height?: number;
}) {
  if (!series || series.length < 2) {
    return <svg className="mt-2 block w-full text-muted-foreground opacity-50" viewBox="0 0 100 20"
      preserveAspectRatio="none" aria-hidden="true" style={{ height }}>
      <path d="M0 10 L100 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 4" strokeLinecap="round" />
    </svg>;
  }

  return <div className={cn("mt-2 w-full", returnColor(tone))} style={{ height }} aria-hidden="true">
    <ResponsiveContainer width="100%" height="100%" debounce={CHART_RESIZE_DEBOUNCE_MS}>
      <LineChart data={series.map((value, index) => ({ index, value }))} margin={{ top: 4, right: 2, left: 2, bottom: 4 }}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Line type="monotone" dataKey="value" stroke="currentColor" strokeWidth={1.8} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
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
        <IndexSparkline tone={metric.degraded ? "neutral" : metric.tone} series={metric.sparkline} height={96} />
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
