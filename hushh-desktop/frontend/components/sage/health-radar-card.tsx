"use client";

import type { LucideIcon } from "lucide-react";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";

export type HealthRadarAxis = { subject: string; value: number };

const healthRadarChartConfig = {
  value: {
    label: "Score",
    color: "rgb(139 92 246)", // violet-500, Sage's accent everywhere else
  },
} satisfies ChartConfig;

/**
 * A prominent radar + score-bar card -- the same shape as Kai's "Portfolio
 * Intelligence & Health" (radar left, big score + Critical/Stable/Optimal
 * gradient bar right), generalized so any Sage surface with a genuine set
 * of real, already-computed 0-100 axis values can use it. Never computes
 * anything itself -- callers own what the axes actually measure and must
 * make sure every value is real, derived data, not invented.
 */
export function HealthRadarCard({
  icon: Icon,
  title,
  axes,
  overall,
  scaleLabels,
}: {
  icon: LucideIcon;
  title: string;
  axes: HealthRadarAxis[];
  overall: number;
  /** [low, mid, high] labels under the gradient bar, e.g. ["Early", "Developing", "Well-established"]. */
  scaleLabels: [string, string, string];
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-violet-500/20 dark:border-violet-400/20">
      <div className="flex items-center gap-2 border-b border-violet-500/10 bg-violet-500/[0.04] px-5 py-3 dark:border-violet-400/10 dark:bg-violet-400/[0.03]">
        <Icon className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden />
        <span className="text-sm font-semibold text-violet-700 dark:text-violet-300">{title}</span>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border/10 md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="flex items-center justify-center p-5">
          <ChartContainer config={healthRadarChartConfig} className="h-[220px] w-full max-w-[280px]">
            <RadarChart cx="50%" cy="50%" outerRadius="75%" data={axes}>
              <PolarGrid stroke="var(--border)" strokeOpacity={0.3} />
              <PolarAngleAxis
                dataKey="subject"
                tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontWeight: 600 }}
              />
              <Radar dataKey="value" stroke="var(--color-value)" fill="var(--color-value)" fillOpacity={0.45} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => {
                      const payload = item?.payload as { subject?: string } | undefined;
                      return (
                        <div className="flex min-w-[7rem] items-center justify-between gap-3">
                          <span className="text-muted-foreground">{payload?.subject}</span>
                          <span className="font-semibold text-foreground">{Number(value).toFixed(0)}%</span>
                        </div>
                      );
                    }}
                  />
                }
              />
            </RadarChart>
          </ChartContainer>
        </div>
        <div className="flex flex-col justify-center gap-4 p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Overall</p>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold text-foreground">{overall}</span>
              <span className="text-lg font-semibold text-muted-foreground/50">%</span>
              <span className="ml-1.5 text-sm text-muted-foreground">
                {overall < 40 ? scaleLabels[0] : overall < 70 ? scaleLabels[1] : scaleLabels[2]}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted/40">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-700 ease-out",
                  overall < 40
                    ? "bg-gradient-to-r from-red-600 to-red-400"
                    : overall < 70
                      ? "bg-gradient-to-r from-amber-500 to-amber-300"
                      : "bg-gradient-to-r from-emerald-600 to-emerald-400",
                )}
                style={{ width: `${overall}%` }}
              />
            </div>
            <div className="flex justify-between px-0.5">
              <span className="text-[9px] font-bold uppercase tracking-wide text-red-500/70">{scaleLabels[0]}</span>
              <span className="text-[9px] font-bold uppercase tracking-wide text-amber-500/70">{scaleLabels[1]}</span>
              <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-500/70">
                {scaleLabels[2]}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
