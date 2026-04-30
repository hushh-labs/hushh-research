"use client";

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

export type RenaissanceSignal = "CONSTRUCTIVE" | "WATCHLIST" | "CAUTION";

function toRenaissanceSignal(bias: string | null | undefined): RenaissanceSignal {
  const text = String(bias || "").trim().toUpperCase();
  if (
    text === "BUY" ||
    text === "STRONG_BUY" ||
    text === "BULLISH" ||
    text === "HOLD_TO_BUY"
  ) return "CONSTRUCTIVE";
  if (
    text === "REDUCE" ||
    text === "SELL" ||
    text === "BEARISH"
  ) return "CAUTION";
  return "WATCHLIST";
}

function signalLabel(signal: RenaissanceSignal): string {
  if (signal === "CONSTRUCTIVE") return "Constructive signal";
  if (signal === "CAUTION") return "Caution signal";
  return "Watchlist signal";
}

function signalSummary(
  signal: RenaissanceSignal,
  row: KaiHomeRenaissanceItem
): string {
  const company = String(row.company_name || row.symbol || "This name").trim();
  const sector = String(row.sector || "").trim();
  const fcf =
    typeof row.fcf_billions === "number" && Number.isFinite(row.fcf_billions)
      ? `$${row.fcf_billions.toFixed(row.fcf_billions >= 10 ? 0 : 1)}B FCF`
      : null;
  const tier = String(row.tier || "").trim();
  const dataQuality = row.degraded
    ? "Data quality is delayed, so Kai treats this as lower-confidence context."
    : null;

  if (signal === "CONSTRUCTIVE") {
    const parts = [
      `${company} currently shows a constructive Renaissance bias.`,
      tier ? `Conviction tier: ${tier}.` : null,
      fcf ? `Free cash flow stands at ${fcf}.` : null,
      sector ? `Sector: ${sector}.` : null,
      dataQuality,
    ].filter(Boolean);
    return parts.join(" ");
  }

  if (signal === "CAUTION") {
    const parts = [
      `${company} currently shows a caution Renaissance bias.`,
      tier ? `Conviction tier: ${tier}.` : null,
      sector ? `Sector: ${sector}.` : null,
      "Review the thesis and data quality before acting on the signal.",
      dataQuality,
    ].filter(Boolean);
    return parts.join(" ");
  }

  const parts = [
    `${company} currently sits in watchlist territory on the Renaissance list.`,
    tier ? `Conviction tier: ${tier}.` : null,
    fcf ? `Free cash flow stands at ${fcf}.` : null,
    "Kai has no high-conviction directional signal from this list alone.",
    dataQuality,
  ].filter(Boolean);
  return parts.join(" ");
}

function signalTone(signal: RenaissanceSignal): {
  container: string;
  badge: string;
  icon: string;
  label: string;
} {
  if (signal === "CONSTRUCTIVE") {
    return {
      container: "border-emerald-500/20 bg-emerald-500/8",
      badge: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      icon: "text-emerald-600 dark:text-emerald-400",
      label: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (signal === "CAUTION") {
    return {
      container: "border-rose-500/20 bg-rose-500/8",
      badge: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      icon: "text-rose-600 dark:text-rose-400",
      label: "text-rose-700 dark:text-rose-300",
    };
  }
  return {
    container: "border-amber-500/20 bg-amber-500/8",
    badge: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: "text-amber-600 dark:text-amber-400",
    label: "text-amber-700 dark:text-amber-300",
  };
}

function VerdictIcon({
  signal,
  className,
}: {
  signal: RenaissanceSignal;
  className?: string;
}) {
  if (signal === "CONSTRUCTIVE") {
    return <TrendingUp className={cn("h-5 w-5", className)} />;
  }
  if (signal === "CAUTION") {
    return <TrendingDown className={cn("h-5 w-5", className)} />;
  }
  return <Minus className={cn("h-5 w-5", className)} />;
}

export function RenaissanceVerdictCard({
  row,
}: {
  row: KaiHomeRenaissanceItem;
}) {
  const signal = toRenaissanceSignal(row.recommendation_bias);
  const tone = signalTone(signal);
  const label = signalLabel(signal);
  const summary = signalSummary(signal, row);
  const hasThesis = Boolean(
    String(row.investment_thesis || "").trim()
  );

  return (
    <SurfaceInset
      className={cn(
        "space-y-4 border p-4",
        tone.container
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Renaissance signal
          </p>
          <div className="flex items-center gap-2">
            <VerdictIcon signal={signal} className={tone.icon} />
            <p className={cn("text-xl font-bold tracking-tight", tone.label)}>
              {label}
            </p>
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn("shrink-0 text-[10px] font-bold uppercase tracking-wide", tone.badge)}
        >
          {signal}
        </Badge>
      </div>

      <p className="text-sm leading-6 text-foreground/80">
        {summary}
      </p>

      {hasThesis ? (
        <div className="space-y-1.5 border-t border-current/10 pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Investment thesis
          </p>
          <p className="text-sm leading-6 text-foreground/75">
            {row.investment_thesis}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-current/10 pt-3">
        <p className="w-full text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Key signals
        </p>
        {row.tier ? (
          <Badge
            variant="outline"
            className="border-[color:var(--app-card-border-standard)] bg-background/60 text-xs text-foreground/70"
          >
            Tier {row.tier}
          </Badge>
        ) : null}
        {row.sector ? (
          <Badge
            variant="outline"
            className="border-[color:var(--app-card-border-standard)] bg-background/60 text-xs text-foreground/70"
          >
            {row.sector}
          </Badge>
        ) : null}
        {typeof row.fcf_billions === "number" &&
        Number.isFinite(row.fcf_billions) ? (
          <Badge
            variant="outline"
            className="border-[color:var(--app-card-border-standard)] bg-background/60 text-xs text-foreground/70"
          >
            ${row.fcf_billions.toFixed(
              row.fcf_billions >= 10 ? 0 : 1
            )}B FCF
          </Badge>
        ) : null}
        {row.degraded ? (
          <Badge
            variant="outline"
            className="border-amber-500/20 bg-amber-500/8 text-xs text-amber-700 dark:text-amber-300"
          >
            Lower confidence
          </Badge>
        ) : null}
      </div>

      <p className="border-t border-current/10 pt-3 text-[11px] leading-5 text-muted-foreground">
        Kai presents this as market context, not a personalized instruction.
      </p>
    </SurfaceInset>
  );
}
