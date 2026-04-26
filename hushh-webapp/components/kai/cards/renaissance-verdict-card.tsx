"use client";

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

export type VerdictDecision = "BUY" | "HOLD" | "REDUCE";

function toVerdictDecision(bias: string | null | undefined): VerdictDecision {
  const text = String(bias || "").trim().toUpperCase();
  if (
    text === "BUY" ||
    text === "STRONG_BUY" ||
    text === "BULLISH" ||
    text === "HOLD_TO_BUY"
  ) return "BUY";
  if (
    text === "REDUCE" ||
    text === "SELL" ||
    text === "BEARISH"
  ) return "REDUCE";
  return "HOLD";
}

function verdictLabel(decision: VerdictDecision): string {
  if (decision === "BUY") return "Buy";
  if (decision === "REDUCE") return "Do not buy";
  return "Hold — watch for entry";
}

function verdictSummary(
  decision: VerdictDecision,
  row: KaiHomeRenaissanceItem
): string {
  const company = String(row.company_name || row.symbol || "This name").trim();
  const sector = String(row.sector || "").trim();
  const fcf =
    typeof row.fcf_billions === "number" && Number.isFinite(row.fcf_billions)
      ? `$${row.fcf_billions.toFixed(row.fcf_billions >= 10 ? 0 : 1)}B FCF`
      : null;
  const tier = String(row.tier || "").trim();

  if (decision === "BUY") {
    const parts = [
      `${company} is currently rated a buy on the Renaissance list.`,
      tier ? `Conviction tier: ${tier}.` : null,
      fcf ? `Free cash flow stands at ${fcf}.` : null,
      sector ? `Sector: ${sector}.` : null,
    ].filter(Boolean);
    return parts.join(" ");
  }

  if (decision === "REDUCE") {
    const parts = [
      `${company} is currently rated reduce — not a buy at this time.`,
      tier ? `Conviction tier: ${tier}.` : null,
      sector ? `Sector: ${sector}.` : null,
      "Consider waiting for an improved entry or a bias change before adding.",
    ].filter(Boolean);
    return parts.join(" ");
  }

  const parts = [
    `${company} is currently rated hold on the Renaissance list.`,
    tier ? `Conviction tier: ${tier}.` : null,
    fcf ? `Free cash flow stands at ${fcf}.` : null,
    "No strong buy or reduce signal is present right now.",
  ].filter(Boolean);
  return parts.join(" ");
}

function verdictTone(decision: VerdictDecision): {
  container: string;
  badge: string;
  icon: string;
  label: string;
} {
  if (decision === "BUY") {
    return {
      container: "border-emerald-500/20 bg-emerald-500/8",
      badge: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      icon: "text-emerald-600 dark:text-emerald-400",
      label: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (decision === "REDUCE") {
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
  decision,
  className,
}: {
  decision: VerdictDecision;
  className?: string;
}) {
  if (decision === "BUY") {
    return <TrendingUp className={cn("h-5 w-5", className)} />;
  }
  if (decision === "REDUCE") {
    return <TrendingDown className={cn("h-5 w-5", className)} />;
  }
  return <Minus className={cn("h-5 w-5", className)} />;
}

export function RenaissanceVerdictCard({
  row,
}: {
  row: KaiHomeRenaissanceItem;
}) {
  const decision = toVerdictDecision(row.recommendation_bias);
  const tone = verdictTone(decision);
  const label = verdictLabel(decision);
  const summary = verdictSummary(decision, row);
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
            Renaissance verdict
          </p>
          <div className="flex items-center gap-2">
            <VerdictIcon decision={decision} className={tone.icon} />
            <p className={cn("text-xl font-bold tracking-tight", tone.label)}>
              {label}
            </p>
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn("shrink-0 text-[10px] font-bold uppercase tracking-wide", tone.badge)}
        >
          {decision}
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
            Delayed data
          </Badge>
        ) : null}
      </div>
    </SurfaceInset>
  );
}