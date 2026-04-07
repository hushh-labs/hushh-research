// components/kai/views/history-detail-view.tsx

/**
 * History Detail View — Renders stored analysis results using Morphy UX
 *
 * Shows a previously computed DecisionCard from an AnalysisHistoryEntry
 * WITHOUT re-triggering a live debate. Uses Morphy UX Card, Button, and
 * standard spacing conventions.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Clock } from "lucide-react";
import { APP_MEASURE_STYLES } from "@/components/app-ui/app-page-shell";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { DecisionCard, type DecisionResult } from "./decision-card";
import { RoundTabsCard } from "./round-tabs-card";
import type { AgentState } from "../debate-stream-view";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import {
  fetchLatestMarketSnapshot,
  getLatestMarketSnapshotFromCache,
  pickPreferredMarketSnapshot,
  type TickerMarketSnapshot,
} from "@/lib/kai/market-snapshot";
import { cn } from "@/lib/utils";

// ============================================================================
// PROPS
// ============================================================================

interface HistoryDetailViewProps {
  entry: AnalysisHistoryEntry;
  onBack?: () => void;
  onReanalyze?: (ticker: string) => void;
  embedded?: boolean;
  userId?: string;
  vaultOwnerToken?: string;
  showHeader?: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getDecisionColor(decision: string): string {
  switch (decision.toLowerCase()) {
    case "buy":
      return "text-emerald-400";
    case "hold":
      return "text-amber-400";
    case "reduce":
      return "text-red-400";
    default:
      return "text-zinc-400";
  }
}

function formatCurrency(value: number | null): string {
  if (value === null) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

// ============================================================================
// COMPONENT
// ============================================================================

export function HistoryDetailView({
  entry,
  onBack,
  onReanalyze,
  embedded = false,
  userId,
  vaultOwnerToken,
  showHeader = true,
}: HistoryDetailViewProps) {
  // State for collapsible transcript rounds
  const [collapsedRounds, setCollapsedRounds] = useState<Record<number, boolean>>({ 1: true, 2: true });

  // Map AnalysisHistoryEntry → DecisionResult for the DecisionCard
  const decisionResult: DecisionResult = useMemo(() => {
    // raw_card contains the full DecisionResult data
    const rawCard = entry.raw_card || {};
    return {
      ticker: entry.ticker,
      decision: entry.decision,
      confidence: entry.confidence,
      consensus_reached: entry.consensus_reached,
      final_statement: entry.final_statement,
      agent_votes: entry.agent_votes,
      raw_card: rawCard,
      short_recommendation:
        typeof rawCard.short_recommendation === "string"
          ? rawCard.short_recommendation
          : undefined,
      analysis_degraded: Boolean(rawCard.analysis_degraded),
      degraded_agents: Array.isArray(rawCard.degraded_agents)
        ? rawCard.degraded_agents.map((value) => String(value))
        : undefined,
    };
  }, [entry]);

  const [marketSnapshot, setMarketSnapshot] = useState<TickerMarketSnapshot | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const cached = getLatestMarketSnapshotFromCache(userId, entry.ticker);
    if (!cancelled) {
      setMarketSnapshot((prev) => pickPreferredMarketSnapshot(prev, cached));
    }

    if (!vaultOwnerToken) return () => {
      cancelled = true;
    };

    void (async () => {
      try {
        const live = await fetchLatestMarketSnapshot({
          userId,
          ticker: entry.ticker,
          vaultOwnerToken,
          daysBack: 7,
        });
        if (!cancelled) {
          setMarketSnapshot((prev) => pickPreferredMarketSnapshot(prev, live));
        }
      } catch {
        // keep best-known quote
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entry.ticker, userId, vaultOwnerToken]);

  const priceLabel = formatCurrency(marketSnapshot?.last_price ?? null);
  const todayChangePct = marketSnapshot?.change_pct ?? null;

  if (embedded) {
    return (
      <div className="mx-auto w-full space-y-4 pb-safe" style={APP_MEASURE_STYLES.reading}>
        {showHeader ? (
          <Card variant="none" effect="glass" preset="default">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <SymbolAvatar symbol={entry.ticker} name={entry.ticker} size="md" />
                <h2 className="text-2xl font-black tracking-tight">{entry.ticker}</h2>
                <span className="text-sm font-semibold tabular-nums text-muted-foreground">{priceLabel}</span>
                {todayChangePct !== null ? (
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs font-semibold",
                      todayChangePct >= 0
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    )}
                  >
                    Today {todayChangePct >= 0 ? "+" : ""}
                    {todayChangePct.toFixed(2)}%
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Today's status unavailable</span>
                )}
              </div>
            </CardContent>
          </Card>
        ) : null}
        <DecisionCard result={decisionResult} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-transparent relative">
      {/* Header - Masked gradient + sticky nav */}
      <div className="flex-none overflow-hidden mb-4">
        {/* Root layout owns the app gradient; keep header readable with a subtle surface only. */}
        <div className="absolute inset-0 backdrop-blur-md bg-background/40" />

        {/* Content */}
        <div className="mx-auto w-full relative pt-3 pb-2" style={APP_MEASURE_STYLES.reading}>
           {/* Breadcrumb-ish / Top Row */}
           <div className="flex items-center justify-between mb-2">
            <Button
                variant="muted"
                size="icon-sm"
                onClick={onBack}
                aria-label="Back to history"
                className="rounded-full hover:bg-background/20"
                disabled={!onBack}
              >
                <Icon icon={ArrowLeft} size="sm" />
            </Button>
            
            <div className="flex items-center gap-2">
                 <span
                className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${getDecisionColor(
                  entry.decision
                )} bg-white/5 border border-white/10`}
              >
                {entry.decision}
              </span>
            </div>
           </div>

           {/* Hero Row */}
           <div className="flex items-end justify-between px-1">
              <div className="flex items-start gap-3">
                <SymbolAvatar symbol={entry.ticker} name={entry.ticker} size="lg" className="mt-0.5" />
                <div>
                  <h1 className="text-2xl font-black tracking-tighter text-foreground leading-none">
                    {entry.ticker}
                  </h1>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums text-muted-foreground">{priceLabel}</span>
                    {todayChangePct !== null ? (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs font-semibold",
                          todayChangePct >= 0
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                        )}
                      >
                        Today {todayChangePct >= 0 ? "+" : ""}
                        {todayChangePct.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Today's status unavailable</span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Icon icon={Clock} size={12} className="shrink-0" />
                    <span>{formatTimestamp(entry.timestamp)}</span>
                  </div>
                </div>
              </div>

               <Button
                variant="gradient"
                size="sm"
                onClick={() => onReanalyze?.(entry.ticker)}
                className="h-8 text-xs"
                disabled={!onReanalyze}
              >
                <Icon icon={RefreshCw} size={12} className="mr-1.5" />
                Re-analyze
              </Button>
           </div>
        </div>
      </div>
      
      <div className="mx-auto w-full space-y-4 pb-safe" style={APP_MEASURE_STYLES.reading}>


      {/* Stored analysis badge */}
      <Card variant="none" effect="glass">
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Icon icon={Clock} size="xs" className="text-blue-400" />
            <span className="font-sans">
              Stored result from {formatTimestamp(entry.timestamp)} — not a live analysis
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Decision Card — rendered from stored data */}
      <DecisionCard result={decisionResult} />

      {/* Debate Transcript (Static Replay) */}
      {entry.debate_transcript && (
        <div className="pt-6 space-y-4 animate-in fade-in slide-in-from-bottom-4  delay-200">
           <div className="flex items-center gap-2 px-1">
              <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground/70">Debate Transcript</h3>
              <div className="h-px bg-border/50 flex-1" />
           </div>
           
           <RoundTabsCard 
              roundNumber={1} 
              title="Initial Deep Analysis" 
              description="Agents analyzed raw data independently."
              isCollapsed={collapsedRounds[1] ?? true} 
              onToggleCollapse={() => setCollapsedRounds(prev => ({ ...prev, 1: !prev[1] }))}
              agentStates={entry.debate_transcript.round1 as Record<string, AgentState>}
           />
           
           {entry.debate_transcript.round2 && Object.keys(entry.debate_transcript.round2).length > 0 && (
             <RoundTabsCard 
                roundNumber={2}
                title="Strategic Debate"
                description="Agents challenged and refined positions."
                isCollapsed={collapsedRounds[2] ?? true}
                onToggleCollapse={() => setCollapsedRounds(prev => ({ ...prev, 2: !prev[2] }))}
                agentStates={entry.debate_transcript.round2 as Record<string, AgentState>}
             />
           )}
        </div>
      )}
    </div>
  </div>
  );
}
