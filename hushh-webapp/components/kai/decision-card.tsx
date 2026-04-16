"use client";

import { useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  Bookmark,
  Share2,
  GitCompareArrows,
  Users,
  ShieldAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { cn } from "@/lib/utils";

import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import type { Holding } from "@/components/kai/types/portfolio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionVerdict = "buy" | "hold" | "reduce" | string;

export interface PortfolioContext {
  /** User's current position in this ticker (from portfolio holdings) */
  holding?: Holding | null;
  /** Total portfolio value used for computing allocation % */
  totalPortfolioValue?: number;
}

export interface PeerInsight {
  /** e.g. "68% of investors like you who hold AAPL rated it a Buy" */
  label: string;
}

export interface DecisionCardProps {
  /** The analysis entry produced by Kai's debate pipeline */
  entry: AnalysisHistoryEntry;
  /** Optional portfolio context (client-side decrypted data) */
  portfolioContext?: PortfolioContext | null;
  /** Optional peer comparison insight */
  peerInsight?: PeerInsight | null;
  /** Callbacks for card actions */
  onSave?: (ticker: string) => void;
  onShare?: (ticker: string) => void;
  onCompare?: (ticker: string) => void;
  /** If true, the card starts with the debate section expanded */
  defaultDebateOpen?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatConfidence(value: number): string {
  // Confidence may come as 0-1 or 0-100 depending on the backend
  const normalized = value > 1 ? value : value * 100;
  return `${Math.round(normalized)}%`;
}

function verdictLabel(decision: DecisionVerdict): string {
  const upper = String(decision).toUpperCase();
  if (upper === "BUY") return "BUY";
  if (upper === "HOLD" || upper === "WATCH") return "HOLD";
  if (upper === "REDUCE" || upper === "SELL") return "REDUCE";
  return upper || "HOLD";
}

function verdictTone(decision: DecisionVerdict): string {
  const label = verdictLabel(decision);
  if (label === "BUY")
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (label === "REDUCE")
    return "bg-orange-500/10 text-orange-700 dark:text-orange-300";
  return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
}

function confidenceTone(confidence: number): "default" | "success" | "warning" | "danger" {
  const normalized = confidence > 1 ? confidence : confidence * 100;
  if (normalized >= 75) return "success";
  if (normalized >= 50) return "warning";
  return "danger";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function extractPrice(entry: AnalysisHistoryEntry): number | null {
  const card = entry.raw_card;
  if (!card || typeof card !== "object") return null;
  const candidates = [
    card.current_price,
    card.price,
    card.last_price,
    card.close,
  ];
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractKeyMetrics(
  entry: AnalysisHistoryEntry
): Array<{ label: string; value: string }> {
  const card = entry.raw_card;
  if (!card || typeof card !== "object") return [];
  const metrics: Array<{ label: string; value: string }> = [];
  const rawMetrics = card.key_metrics ?? card.keyMetrics;
  if (rawMetrics && typeof rawMetrics === "object") {
    const map = rawMetrics as Record<string, unknown>;
    if (map.pe_ratio !== undefined)
      metrics.push({ label: "P/E", value: String(Number(map.pe_ratio).toFixed(1)) });
    if (map.market_cap !== undefined)
      metrics.push({ label: "Mkt Cap", value: String(map.market_cap) });
    if (map.dividend_yield !== undefined)
      metrics.push({
        label: "Div Yield",
        value: `${Number(map.dividend_yield).toFixed(2)}%`,
      });
    if (map.beta !== undefined)
      metrics.push({ label: "Beta", value: String(Number(map.beta).toFixed(2)) });
  }
  return metrics.slice(0, 4);
}

function agentVoteSummary(
  votes: Record<string, string>
): Array<{ agent: string; vote: string }> {
  return Object.entries(votes).map(([agent, vote]) => ({
    agent: agent.charAt(0).toUpperCase() + agent.slice(1),
    vote: String(vote).toUpperCase(),
  }));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PortfolioContextBlock({
  holding,
  totalPortfolioValue,
}: {
  holding: Holding;
  totalPortfolioValue?: number;
}) {
  const allocationPct =
    totalPortfolioValue && totalPortfolioValue > 0
      ? (holding.market_value / totalPortfolioValue) * 100
      : null;
  const positive = (holding.unrealized_gain_loss ?? 0) >= 0;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
        For YOUR Portfolio
      </p>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            Shares
          </p>
          <p className="font-semibold">{holding.quantity.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            Value
          </p>
          <p className="font-semibold">{formatCurrency(holding.market_value)}</p>
        </div>
        {allocationPct !== null && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
              Allocation
            </p>
            <p className="font-semibold">{allocationPct.toFixed(1)}%</p>
          </div>
        )}
      </div>
      {holding.unrealized_gain_loss !== undefined && (
        <p
          className={cn(
            "text-xs font-semibold",
            positive ? "text-emerald-600" : "text-red-500"
          )}
        >
          {positive ? "+" : ""}
          {formatCurrency(holding.unrealized_gain_loss)}
          {holding.unrealized_gain_loss_pct !== undefined &&
            ` (${formatPct(holding.unrealized_gain_loss_pct)})`}
        </p>
      )}
    </div>
  );
}

function DebateSection({
  entry,
  defaultOpen,
}: {
  entry: AnalysisHistoryEntry;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const votes = agentVoteSummary(entry.agent_votes);
  const transcript = entry.debate_transcript;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40"
        >
          <span>Agent Debate {entry.consensus_reached ? "(Consensus)" : "(Split)"}</span>
          <Icon icon={open ? ChevronUp : ChevronDown} size="sm" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-3">
          {/* Agent votes */}
          {votes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {votes.map(({ agent, vote }) => (
                <Badge
                  key={agent}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide",
                    vote === "BUY"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : vote === "REDUCE" || vote === "SELL"
                        ? "bg-orange-500/10 text-orange-700 dark:text-orange-300"
                        : "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                  )}
                >
                  {agent}: {vote}
                </Badge>
              ))}
            </div>
          )}

          {/* Round summaries from transcript */}
          {transcript && (
            <div className="space-y-2">
              {(["round1", "round2"] as const).map((round) => {
                const agents = transcript[round];
                if (!agents || typeof agents !== "object") return null;
                return (
                  <div key={round} className="space-y-1">
                    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
                      {round === "round1" ? "Round 1 - Analysis" : "Round 2 - Debate"}
                    </p>
                    {Object.entries(agents).map(([agentKey, agentData]) => {
                      const data = agentData as Record<string, unknown>;
                      const text = String(data?.text || data?.summary || "").trim();
                      if (!text) return null;
                      return (
                        <div
                          key={agentKey}
                          className="rounded-lg bg-muted/30 px-3 py-2 text-xs leading-relaxed"
                        >
                          <span className="font-bold capitalize text-foreground/80">
                            {agentKey}:
                          </span>{" "}
                          <span className="text-muted-foreground line-clamp-3">
                            {text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function DecisionCard({
  entry,
  portfolioContext,
  peerInsight,
  onSave,
  onShare,
  onCompare,
  defaultDebateOpen = false,
  className,
}: DecisionCardProps) {
  const price = extractPrice(entry);
  const keyMetrics = extractKeyMetrics(entry);
  const holding = portfolioContext?.holding;
  const label = verdictLabel(entry.decision);

  return (
    <Card
      variant="none"
      effect="glass"
      preset="surface"
      showRipple={false}
      glassAccent="soft"
      className={cn(
        "group relative isolate !overflow-hidden !gap-0 !py-0 rounded-[24px] transition-[border-color,box-shadow] duration-200 ease-out",
        className
      )}
    >
      <CardContent className="relative z-[1] space-y-4 p-5">
        {/* ---- Header: ticker + verdict badge ---- */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <SymbolAvatar symbol={entry.ticker} size="md" />
            <div className="min-w-0 space-y-0.5">
              <h3 className="text-base font-black tracking-tight leading-tight">
                {entry.ticker}
              </h3>
              {price !== null && (
                <p className="text-sm text-muted-foreground">
                  {formatCurrency(price)}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center rounded-full bg-background/75 px-2 py-1 text-[10px] font-bold tracking-wide text-muted-foreground">
              {formatConfidence(entry.confidence)} conf.
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-extrabold tracking-wide",
                verdictTone(entry.decision)
              )}
            >
              {label}
            </span>
          </div>
        </div>

        {/* ---- Key metrics strip ---- */}
        {keyMetrics.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {keyMetrics.map((m) => (
              <span key={m.label} className="text-muted-foreground">
                <span className="font-bold text-foreground/70">{m.label}</span>{" "}
                {m.value}
              </span>
            ))}
          </div>
        )}

        {/* ---- Final statement ---- */}
        {entry.final_statement && (
          <p className="text-sm font-medium leading-relaxed">
            {entry.final_statement}
          </p>
        )}

        {/* ---- Personalized portfolio context ---- */}
        {holding && (
          <PortfolioContextBlock
            holding={holding}
            totalPortfolioValue={portfolioContext?.totalPortfolioValue}
          />
        )}

        {/* ---- Debate section (expandable) ---- */}
        <DebateSection entry={entry} defaultOpen={defaultDebateOpen} />

        {/* ---- Peer insight ---- */}
        {peerInsight && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <Icon icon={Users} size="sm" className="shrink-0" />
            <span>{peerInsight.label}</span>
          </div>
        )}

        {/* ---- Actions: Save / Share / Compare ---- */}
        <div className="flex items-center gap-2 border-t border-border/40 pt-3">
          {onSave && (
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => onSave(entry.ticker)}
              aria-label={`Save analysis for ${entry.ticker}`}
            >
              <Icon icon={Bookmark} size="sm" className="mr-1.5" />
              Save
            </Button>
          )}
          {onShare && (
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => onShare(entry.ticker)}
              aria-label={`Share analysis for ${entry.ticker}`}
            >
              <Icon icon={Share2} size="sm" className="mr-1.5" />
              Share
            </Button>
          )}
          {onCompare && (
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => onCompare(entry.ticker)}
              aria-label={`Compare analysis for ${entry.ticker}`}
            >
              <Icon icon={GitCompareArrows} size="sm" className="mr-1.5" />
              Compare
            </Button>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/60">
            {relativeTime(entry.timestamp)}
          </span>
        </div>

        {/* ---- Disclaimer (always visible per spec) ---- */}
        <div className="flex items-start gap-1.5 rounded-lg bg-muted/15 px-3 py-2 text-[10px] leading-snug text-muted-foreground/60">
          <Icon icon={ShieldAlert} size="xs" className="mt-0.5 shrink-0" />
          <span>
            For informational purposes only. Not financial advice. All data is
            processed locally on your device.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export default DecisionCard;
