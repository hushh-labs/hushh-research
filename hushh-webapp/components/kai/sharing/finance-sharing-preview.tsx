"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, CHART_ANIMATION_ACTIVE, CHART_TOOLTIP_TRIGGER } from "@/components/ui/chart";
import type { FinanceProjection } from "@/lib/finance-sharing/contract";
import styles from "./finance-sharing.module.css";

const colors = ["var(--app-accent)", "var(--app-indigo)", "#30b0c7", "var(--app-warning)", "var(--app-purple)", "var(--app-success)"];
const money = (value: number, currency = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
const percent = (value: number) => `${value.toFixed(1)}%`;

/** Renders the already filtered recipient object. Never receives the owner's model. */
export function FinanceSharingPreview({ projection }: { projection: FinanceProjection }) {
  const chartId = `finance-share-${useId().replace(/:/g, "")}`;
  const performance = projection.performance;
  const formatValue = (value: number) => performance?.unit === "USD" ? money(value) : percent(value);
  return <div className={styles.section}>
    {performance ? <section className={styles.group} aria-label="Shared performance">
      <h3 className="text-sm font-semibold">Performance</h3>
      {performance.total ? <p className={styles.value}>{money(performance.total.value, performance.total.currency)}</p> : null}
      <p className="mt-1 text-sm tabular-nums">{performance.balanceChangePct === null ? "Period balance change is unavailable for this source." : `${performance.balanceChangePct > 0 ? "+" : ""}${percent(performance.balanceChangePct)} balance change over the shared period`}</p>
      <p className={styles.caption}>Balance changes can include deposits and withdrawals.</p>
      {performance.history.length >= 2 ? <ChartContainer config={{ value: { label: performance.unit === "USD" ? "USD" : "Balance change", color: colors[0] } }} className="mt-5 aspect-auto h-[180px] w-full">
        <AreaChart data={performance.history} accessibilityLayer margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
          <defs><linearGradient id={chartId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[0]} stopOpacity={.22} /><stop offset="100%" stopColor={colors[0]} stopOpacity={.01} /></linearGradient></defs>
          <CartesianGrid vertical={false} strokeDasharray="3 4" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tickFormatter={date => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(String(date).length === 10 ? { timeZone: "UTC" } : {}) }).format(new Date(date))} />
          <YAxis orientation="right" width={60} tickCount={3} tickLine={false} axisLine={false} tickFormatter={formatValue} domain={["auto", "auto"]} />
          <ChartTooltip trigger={CHART_TOOLTIP_TRIGGER} content={<ChartTooltipContent formatter={value => formatValue(Number(value))} />} />
          <Area dataKey="value" type="linear" stroke={colors[0]} strokeWidth={2} fill={`url(#${chartId})`} isAnimationActive={CHART_ANIMATION_ACTIVE} />
        </AreaChart>
      </ChartContainer> : <p className={`${styles.caption} mt-4`}>No saved value history is available. No chart has been estimated.</p>}
    </section> : null}
    {projection.allocation ? <section className={styles.group} aria-label="Shared allocation">
      <h3 className="mb-4 text-sm font-semibold">Allocation</h3>
      <div className={styles.bar} aria-hidden="true">{projection.allocation.map((row, i) => <span key={row.name} style={{ width: `${Math.max(0, row.percent)}%`, background: colors[i % colors.length] }} />)}</div>
      {projection.allocation.map((row, i) => <div key={row.name} className={styles.row}><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: colors[i % colors.length] }} />{row.name}</span><span className="text-right tabular-nums">{row.amount ? <>{money(row.amount.value, row.amount.currency)}<br /></> : null}{percent(row.percent)}</span></div>)}
      {projection.sectors?.length ? <div className="mt-4"><p className={styles.caption}>Equity sectors</p>{projection.sectors.map(row => <div key={row.name} className={styles.row}><span>{row.name}</span><span className="tabular-nums">{percent(row.percent)}</span></div>)}</div> : null}
    </section> : null}
    {projection.holdings ? <section className={styles.group} aria-label="Shared stocks"><h3 className="text-sm font-semibold">Selected stocks</h3>
      {projection.holdings.map(row => <div key={row.symbol} className={styles.row}><div><p className="font-semibold">{row.symbol}</p><p className={styles.caption}>{row.name}</p>{row.quantity !== undefined ? <p className={styles.caption}>{row.quantity.toLocaleString()} shares</p> : null}</div><div className="text-right tabular-nums">{row.amount ? <p>{money(row.amount.value, row.amount.currency)}</p> : null}<p>{percent(row.weightPct)} weight</p>{row.gainLossPct !== null ? <p className={styles.caption}>{percent(row.gainLossPct)} unrealized</p> : null}</div></div>)}
    </section> : null}
    {projection.note !== undefined ? <section className={styles.group} aria-label="Shared note"><h3 className="mb-2 text-sm font-semibold">A note from the owner</h3><p className="whitespace-pre-wrap break-words text-sm leading-[21px]">{projection.note || "No note added."}</p></section> : null}
    <p className={styles.caption}>{projection.source === "statement" ? "Statement information" : "Linked portfolio information"}{projection.sourcePeriod ? ` · ${projection.sourcePeriod}` : ""}</p>
  </div>;
}
