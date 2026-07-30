"use client";

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

export type RenaissanceSignal = "CONSTRUCTIVE" | "WATCHLIST" | "CAUTION";

function toRenaissanceSignal(
  bias: string | null | undefined,
): RenaissanceSignal {
  const text = String(bias || "")
    .trim()
    .toUpperCase();
  if (
    text === "BUY" ||
    text === "STRONG_BUY" ||
    text === "BULLISH" ||
    text === "HOLD_TO_BUY"
  )
    return "CONSTRUCTIVE";
  if (text === "REDUCE" || text === "SELL" || text === "BEARISH")
    return "CAUTION";
  return "WATCHLIST";
}

function signalLabel(signal: RenaissanceSignal): string {
  if (signal === "CONSTRUCTIVE") return "Constructive signal";
  if (signal === "CAUTION") return "Caution signal";
  return "Watchlist signal";
}

function signalSummary(
  signal: RenaissanceSignal,
  row: KaiHomeRenaissanceItem,
): string {
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
      "Constructive bias on the active advisor list.",
      tier ? `Conviction tier: ${tier}.` : null,
      fcf ? `Free cash flow stands at ${fcf}.` : null,
      dataQuality,
    ].filter(Boolean);
    return parts.join(" ");
  }

  if (signal === "CAUTION") {
    const parts = [
      "Caution bias on the active advisor list.",
      tier ? `Conviction tier: ${tier}.` : null,
      "Review the thesis and data quality before acting on the signal.",
      dataQuality,
    ].filter(Boolean);
    return parts.join(" ");
  }

  const parts = [
    "Watchlist posture on the active advisor list.",
    tier ? `Conviction tier: ${tier}.` : null,
    fcf ? `Free cash flow stands at ${fcf}.` : null,
    "Kai has no high-conviction directional signal from this list alone.",
    dataQuality,
  ].filter(Boolean);
  return parts.join(" ");
}

function signalTone(signal: RenaissanceSignal): {
  badge: string;
  icon: string;
  label: string;
} {
  if (signal === "CONSTRUCTIVE") {
    return {
      badge:
        "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      icon: "text-emerald-600 dark:text-emerald-400",
      label: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (signal === "CAUTION") {
    return {
      badge:
        "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      icon: "text-rose-600 dark:text-rose-400",
      label: "text-rose-700 dark:text-rose-300",
    };
  }
  return {
    badge:
      "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
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

  return (
    <div className="border-b border-[color:var(--app-card-border-standard)] pb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <VerdictIcon signal={signal} className={tone.icon} />
          <p className={cn("truncate text-sm font-semibold", tone.label)}>
            {label}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 text-[10px] font-semibold uppercase tracking-wide",
            tone.badge,
          )}
        >
          {signal}
        </Badge>
      </div>

      <p className="mt-2 text-sm leading-6 text-foreground/80">{summary}</p>

      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        Kai presents this as market context, not a personalized instruction.
      </p>
    </div>
  );
}
