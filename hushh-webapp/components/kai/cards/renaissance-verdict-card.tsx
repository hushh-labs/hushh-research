"use client";

import { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

// =============================================================================
// CONFIGURATION
// =============================================================================

export type RenaissanceSignal = "CONSTRUCTIVE" | "WATCHLIST" | "CAUTION";

const SIGNAL_CONFIG = {
  CONSTRUCTIVE: {
    label: "Constructive signal",
    border: "border-l-4 border-emerald-500",
    container: "bg-emerald-500/[0.03]",
    badge: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: TrendingUp,
    iconColor: "text-emerald-600",
  },
  CAUTION: {
    label: "Caution signal",
    border: "border-l-4 border-rose-500",
    container: "bg-rose-500/[0.03]",
    badge: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    icon: TrendingDown,
    iconColor: "text-rose-600",
  },
  WATCHLIST: {
    label: "Watchlist signal",
    border: "border-l-4 border-amber-500",
    container: "bg-amber-500/[0.03]",
    badge: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: Minus,
    iconColor: "text-amber-600",
  },
} as const;

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function RenaissanceVerdictCard({ row }: { row: KaiHomeRenaissanceItem }) {
  const signalType = useMemo<RenaissanceSignal>(() => {
    const bias = String(row.recommendation_bias || "").trim().toUpperCase();
    if (["BUY", "STRONG_BUY", "BULLISH", "HOLD_TO_BUY"].includes(bias)) return "CONSTRUCTIVE";
    if (["REDUCE", "SELL", "BEARISH"].includes(bias)) return "CAUTION";
    return "WATCHLIST";
  }, [row.recommendation_bias]);

  const config = SIGNAL_CONFIG[signalType];

  const summary = useMemo(() => {
    const company = row.company_name || row.symbol || "This company";
    const fcf = typeof row.fcf_billions === "number" ? `$${row.fcf_billions.toFixed(row.fcf_billions >= 10 ? 0 : 1)}B` : null;

    let text = `${company} currently shows a ${signalType.toLowerCase()} Renaissance bias.${fcf ? ` With ${fcf} in free cash flow.` : ""}`;
    if (signalType === "CAUTION") {
      text += " Review the thesis and data quality before acting on the signal.";
    }
    return text;
  }, [row, signalType]);

  return (
    <SurfaceInset className={cn("space-y-4 p-5 transition-all duration-300", config.border, config.container)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <config.icon className={cn("h-5 w-5", config.iconColor)} aria-hidden="true" />
          <h4 className={cn("font-bold", config.iconColor)}>{config.label}</h4>
        </div>
        <Badge variant="outline" className={cn("text-[10px] font-semibold uppercase", config.badge)}>
          {signalType}
        </Badge>
      </div>

      {/* Main Body */}
      <p className="text-sm text-foreground/80 leading-relaxed">{summary}</p>

      {/* Thesis */}
      {row.investment_thesis && (
        <div className="space-y-1.5 border-t border-current/10 pt-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Investment thesis</p>
          <blockquote className="text-sm text-foreground/75 italic border-l-2 border-current/20 pl-3">
            "{row.investment_thesis}"
          </blockquote>
        </div>
      )}

      {/* Footer Meta */}
      <div className="flex flex-wrap gap-2 pt-2">
        {row.tier && <Badge variant="secondary" className="text-[10px]">Tier {row.tier}</Badge>}
        {row.sector && <Badge variant="secondary" className="text-[10px]">{row.sector}</Badge>}
        {row.degraded && (
          <Badge variant="outline" className="border-amber-500/30 text-amber-700 text-[10px]">
            <AlertCircle className="mr-1 h-3 w-3" /> Lower confidence
          </Badge>
        )}
      </div>

      {/* Footer disclaimer */}
      <p className="border-t border-current/10 pt-3 text-[11px] leading-5 text-muted-foreground">
        Kai presents this as market context, not a personalized instruction.
      </p>
    </SurfaceInset>
  );
}