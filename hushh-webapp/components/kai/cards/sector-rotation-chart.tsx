"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { CHART_RESIZE_DEBOUNCE_MS } from "@/components/ui/chart";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import type { KaiHomeSectorItem } from "@/lib/services/api-service";
import type { VoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { cn } from "@/lib/utils";
import marketBriefingStyles from "@/components/kai/shared/market-briefing.module.css";

function formatOneMarketPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function sectorRowsForPeriod(rows: KaiHomeSectorItem[], period: "1d" | "1w") {
  return rows.map((row) => ({
    ...row,
    changePct: period === "1w" ? row.change_1w_pct : row.change_pct,
  })).filter((row): row is typeof row & { changePct: number } =>
    Boolean(row.sector) && typeof row.changePct === "number" && Number.isFinite(row.changePct),
  ).sort((left, right) => right.changePct - left.changePct);
}

export function getMarketSectorPeriodVoiceInventory(visible: boolean, hasMoreSectors = false): Required<Pick<VoiceSurfaceMetadata, "actions" | "controls">> {
  if (!visible) return { actions: [], controls: [] };
  return {
    actions: [
      {
        id: "market.sectors.show_day",
        label: "Show sector rotation for 1 day",
        purpose: "Shows the latest trading session's sector ETF returns.",
        voiceAliases: ["show daily sector rotation", "sector rotation for one day"],
      },
      {
        id: "market.sectors.show_week",
        label: "Show sector rotation for 1 week",
        purpose: "Shows sector ETF returns over five trading sessions.",
        voiceAliases: ["show weekly sector rotation", "sector rotation for one week"],
      },
      ...(hasMoreSectors ? [
        { id: "market.sectors.show_all", label: "Show all sectors", purpose: "Expands the sector list for the selected return period.", voiceAliases: ["all sectors", "expand sector rotation"] },
        { id: "market.sectors.show_highlights", label: "Show sector highlights", purpose: "Shows the three strongest and three weakest sectors for the selected return period.", voiceAliases: ["sector highlights", "shorten sector rotation"] },
      ] : []),
    ],
    controls: [{
      id: "kai_market_sector_period",
      label: "Sector rotation period",
      purpose: "Switches between 1 day and 1 week sector returns.",
      role: "selector",
      voiceAliases: ["sector period", "sector rotation period"],
    }, ...(hasMoreSectors ? [{ id: "kai_market_sector_scope", label: "Sector list size", purpose: "Switches between six sector highlights and the full list.", role: "button" as const, voiceAliases: ["all sectors", "sector highlights"] }] : [])],
  };
}

export function SectorRotationChart({ rows, active = true, onScopeAvailabilityChange }: { rows: KaiHomeSectorItem[]; active?: boolean; onScopeAvailabilityChange?: (available: boolean) => void }) {
  const [period, setPeriod] = useState<"1d" | "1w">("1d");
  const [expanded, setExpanded] = useState(false);
  const chartRows = useMemo(() => sectorRowsForPeriod(rows, period), [rows, period]);
  const canExpand = chartRows.length > 6;
  useEffect(() => { onScopeAvailabilityChange?.(active && canExpand); }, [active, canExpand, onScopeAvailabilityChange]);
  useLocalOnboardingActionHandler("market.sectors.show_day", () => {
    setPeriod("1d");
    return { status: "succeeded", summary: "Showing daily sector performance." };
  }, { enabled: active });
  useLocalOnboardingActionHandler("market.sectors.show_week", () => {
    setPeriod("1w");
    return { status: "succeeded", summary: "Showing five-session sector performance." };
  }, { enabled: active });
  useLocalOnboardingActionHandler("market.sectors.show_all", () => {
    setExpanded(true);
    return { status: "succeeded", summary: "Showing all available sectors." };
  }, { enabled: active && canExpand });
  useLocalOnboardingActionHandler("market.sectors.show_highlights", () => {
    setExpanded(false);
    return { status: "succeeded", summary: "Showing sector highlights." };
  }, { enabled: active && canExpand });
  const visibleRows = expanded || chartRows.length <= 6 ? chartRows : [...chartRows.slice(0, 3), ...chartRows.slice(-3)];
  const starts = chartRows.map((row) => period === "1w" ? row.period_start_1w : row.period_start_1d).filter(Boolean).sort();
  const ends = chartRows.map((row) => row.period_end).filter(Boolean).sort();
  const dateRange = starts.length && ends.length ? `${starts[0]} to ${ends.at(-1)}` : "Period dates unavailable";
  const maximumReturn = Math.max(0.01, ...chartRows.map((row) => Math.abs(row.changePct)));
  return (
    <div className={marketBriefingStyles.sectorContent}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
        <p className="self-center text-sm font-semibold leading-5 text-foreground">
          {period === "1w" ? "Five trading sessions" : "Daily price change"}
        </p>
        <div className="col-start-2 row-start-1 sm:row-span-2 sm:self-center" data-voice-control-id="kai_market_sector_period">
          <SegmentedTabs value={period} onValueChange={(value) => setPeriod(value === "1w" ? "1w" : "1d")}
            ariaLabel="Sector performance period" variant="filter" className="w-auto"
            options={[{ value: "1d", label: "1 day" }, { value: "1w", label: "1 week" }]} />
        </div>
        <p className="col-span-2 text-xs leading-5 text-muted-foreground sm:col-span-1">
          {dateRange}
          {chartRows[0]?.basis ? ` · ${chartRows[0].basis}` : ""}
        </p>
      </div>
      {!chartRows.length ? <p className="py-5 text-sm text-muted-foreground">{period === "1w" ? "Weekly" : "Daily"} sector performance is unavailable.</p> : (
      <>
      <div className={cn(marketBriefingStyles.sectorRows, "sm:hidden")}>
        {visibleRows.map((row) => {
          const width = Math.abs(row.changePct) / maximumReturn * 50;
          return <div key={row.sector} className={marketBriefingStyles.sectorRow}>
              <span className="text-foreground">{row.sector}</span>
            <div className="relative h-1 rounded-full bg-muted" aria-hidden="true">
              <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <span className="absolute inset-y-0 rounded-full" style={{ width: `${width}%`, left: `${row.changePct >= 0 ? 50 : 50 - width}%`, background: row.changePct >= 0 ? "var(--one-up)" : "var(--one-down)" }} />
            </div>
            <span className={cn("text-right font-semibold tabular-nums", row.changePct >= 0 ? "text-[color:var(--one-up)]" : "text-[color:var(--one-down)]")}>{formatOneMarketPercent(row.changePct)}</span>
          </div>;
        })}
      </div>
      <div className="hidden w-full sm:block" style={{ height: Math.max(180, visibleRows.length * 28) }}>
      <ResponsiveContainer width="100%" height="100%" debounce={CHART_RESIZE_DEBOUNCE_MS}>
        <BarChart
          data={visibleRows}
          layout="vertical"
          margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
        >
          <CartesianGrid
            horizontal={false}
            strokeDasharray="3 3"
            stroke="var(--one-line)"
          />
          <XAxis
            type="number"
            tickFormatter={(value) => `${value >= 0 ? "+" : ""}${value}%`}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "var(--one-fg3)" }}
          />
          <YAxis
            type="category"
            dataKey="sector"
            axisLine={false}
            tickLine={false}
            width={128}
            tick={{ fontSize: 11, fill: "var(--one-fg2)" }}
          />
          <YAxis yAxisId="returns" orientation="right" type="category" dataKey="changePct"
            tickFormatter={(value) => formatOneMarketPercent(Number(value))}
            axisLine={false} tickLine={false} width={56}
            tick={{ fontSize: 11, fill: "var(--one-fg2)" }} />
          <Bar
            dataKey="changePct"
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
            isAnimationActive={false}
          >
            {visibleRows.map((row) => (
              <Cell
                key={row.sector}
                fill={row.changePct >= 0 ? "var(--one-up)" : "var(--one-down)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      </div></>)}
      {canExpand ? <div className="flex flex-wrap items-center justify-between gap-x-3">
        <span className="text-xs text-muted-foreground">{!expanded && chartRows.length > 6 ? "3 highest · 3 lowest" : "All available sectors"}</span>
        <Button variant="none" effect="fade" size="sm" className="min-h-11 px-1 text-xs" data-voice-control-id="kai_market_sector_scope"
          aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Show highlights" : `All ${chartRows.length} sectors`}
        </Button>
      </div> : null}
      <ul className="sr-only">{visibleRows.map((row) => <li key={row.sector}>{row.sector}: {row.changePct >= 0 ? "+" : ""}{row.changePct.toFixed(2)}%</li>)}</ul>
    </div>
  );
}
