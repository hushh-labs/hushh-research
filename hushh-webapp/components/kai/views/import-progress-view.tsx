/**
 * ImportProgressView Component
 *
 * Real-time streaming progress UI for portfolio import.
 * Stream panels:
 * 1. AI stream
 * 2. Confirmed Holdings
 */

"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/morphy-ux";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Progress } from "@/components/ui/progress";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Activity, CheckCircle2, ChevronDown, ChevronUp, FileChartColumn, X } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";
import { useSmoothStreamProgress } from "@/lib/morphy-ux/hooks/use-smooth-stream-progress";
import { toInvestorStreamText } from "@/lib/copy/investor-language";
import type { LiveHoldingPreview } from "@/lib/kai/import/live-holdings-preview";
import {
  getLiveHoldingPositionSide,
  normalizeLiveHoldingPreviewRows,
} from "@/lib/kai/import/live-holdings-preview";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export type ImportStage =
  | "idle"
  | "uploading"
  | "indexing"
  | "scanning"
  | "thinking"
  | "extracting"
  | "normalizing"
  | "validating"
  | "complete"
  | "error";

export interface ImportProgressViewProps {
  stage: ImportStage;
  isStreaming: boolean;
  progressPct?: number;
  statusMessage?: string;
  stageTrail?: string[];
  thoughts?: string[];
  rawStreamLines?: string[];
  thoughtCount?: number;
  liveHoldings?: LiveHoldingPreview[];
  holdingsExtracted?: number;
  holdingsTotal?: number;
  errorMessage?: string;
  onCancel?: () => void;
  onRetry?: () => void;
  onContinue?: () => void;
  onBackToDashboard?: () => void;
  className?: string;
}

const stageMessages: Record<ImportStage, string> = {
  idle: "Ready to import",
  uploading: "Processing uploaded file...",
  indexing: "Indexing document...",
  scanning: "Scanning pages and sections...",
  thinking: "Preparing your portfolio details...",
  extracting: "Extracting financial data...",
  normalizing: "Normalizing extracted data...",
  validating: "Validating extracted holdings...",
  complete: "Import complete!",
  error: "Import failed",
};

function normalizeStreamLine(rawLine: string): string {
  const normalized = String(rawLine || "")
    .replace(/```(?:json)?/gi, " ")
    .replace(/```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (/^[\]\[\{\},:]+$/.test(normalized)) return "";
  const tagged = normalized.match(/^\[([^\]]+)\]\s*(.*)$/);
  const payloadText = tagged ? (tagged[2] || "").trim() : normalized;
  const looksStructuredPayload =
    (!tagged && /^\s*[\[{]/.test(normalized)) ||
    /"[^"]+"\s*:/.test(payloadText) ||
    /(?:portfolio_data_v2|raw_extract_v2|analytics_v2|quality_report_v2|holdings_preview|progress_pct|chunk_count|total_chars|run_id|cursor|seq)\b/i.test(
      payloadText
    );
  if (tagged) {
    const tag = (tagged[1] || "").trim().toUpperCase();
    const cleaned = (tagged[2] || "").trim();
    const message = looksStructuredPayload ? "" : toInvestorStreamText(cleaned);
    return message ? `[${tag}] ${message}` : "";
  }
  if (looksStructuredPayload) {
    return "";
  }
  return toInvestorStreamText(normalized);
}

function streamLineKey(line: string): string {
  const normalized = normalizeStreamLine(line);
  const match = normalized.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) return normalized.toLowerCase();
  const tag = (match[1] || "").trim().toUpperCase();
  const message = (match[2] || "").trim().toLowerCase();
  return `[${tag}] ${message}`;
}

function splitTaggedLine(line: string): { tag?: string; message: string } {
  const normalized = normalizeStreamLine(line);
  const match = normalized.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) return { message: normalized };
  const tag = (match[1] || "").trim();
  const message = (match[2] || "").trim();
  return { tag: tag || undefined, message: message || normalized };
}

export function ImportProgressView({
  stage,
  isStreaming,
  progressPct,
  statusMessage,
  stageTrail = [],
  rawStreamLines = [],
  thoughtCount: _thoughtCount = 0,
  liveHoldings = [],
  holdingsExtracted = 0,
  holdingsTotal,
  errorMessage,
  onCancel,
  onRetry,
  onContinue,
  onBackToDashboard,
  className,
}: ImportProgressViewProps) {
  const [streamExpanded, setStreamExpanded] = useState<boolean>(() => true);
  const [holdingsExpanded, setHoldingsExpanded] = useState<boolean>(() => true);

  const hasMeasuredProgress = useMemo(
    () => typeof progressPct === "number" && Number.isFinite(progressPct) && progressPct > 0,
    [progressPct]
  );

  const resolvedProgress = useMemo(() => {
    if (hasMeasuredProgress) return Math.max(0, Math.min(100, progressPct as number));
    if (stage === "complete" || stage === "error") return 100;
    return 0;
  }, [hasMeasuredProgress, progressPct, stage]);

  const smoothProgress = useSmoothStreamProgress(resolvedProgress, {
    // Reset any previous-run visual floor while backend is still in stage-tracking mode.
    resetHint: !hasMeasuredProgress && stage !== "complete" && stage !== "error",
  });

  const fallbackRawLines = useMemo(() => {
    const lines = stageTrail.length > 0 ? stageTrail : [statusMessage || stageMessages[stage]];
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const line of lines) {
      const next = normalizeStreamLine(line);
      if (!next) continue;
      const key = streamLineKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(next);
    }
    return normalized;
  }, [stageTrail, statusMessage, stage]);

  const effectiveRawLines = useMemo(() => {
    if (rawStreamLines.length > 0) {
      return rawStreamLines
        .map((line) => normalizeStreamLine(line))
        .filter(Boolean);
    }
    return fallbackRawLines;
  }, [rawStreamLines, fallbackRawLines]);

  const uniqueLiveHoldings = useMemo(() => {
    return normalizeLiveHoldingPreviewRows(liveHoldings);
  }, [liveHoldings]);
  const streamLinesForDisplay = useMemo(() => effectiveRawLines.slice(-80), [effectiveRawLines]);
  const showConfirmedHoldings = uniqueLiveHoldings.length > 0 || stage === "complete";
  const displayHoldings = showConfirmedHoldings ? uniqueLiveHoldings : [];
  const holdingsCount =
    showConfirmedHoldings && displayHoldings.length > 0
      ? displayHoldings.length
      : holdingsExtracted;
  const latestStreamUpdate = effectiveRawLines.length
    ? effectiveRawLines[effectiveRawLines.length - 1]
    : undefined;
  const displayStatusMessage = useMemo(
    () => normalizeStreamLine(statusMessage || stageMessages[stage]),
    [statusMessage, stage]
  );

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Icon icon={FileChartColumn} size="md" className={cn(isStreaming && "text-primary")} />
            <CardTitle className="text-lg">Importing Portfolio</CardTitle>
          </div>
          {onCancel && stage !== "complete" && (
            <MorphyButton
              variant="muted"
              size="sm"
              onClick={onCancel}
              className="h-8 rounded-lg"
              icon={{ icon: X }}
            >
              Cancel
            </MorphyButton>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Import progress</span>
            <span>
              {hasMeasuredProgress || stage === "complete" || stage === "error"
                ? `${Math.round(smoothProgress)}%`
                : "Tracking stages"}
            </span>
          </div>
          {hasMeasuredProgress || stage === "complete" || stage === "error" ? (
            <Progress
              value={smoothProgress}
              className={cn("h-2", isStreaming && "transition-all")}
            />
          ) : (
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full w-1/3 rounded-full bg-primary/70 animate-pulse" />
            </div>
          )}
        </div>

        <p className="text-sm text-muted-foreground">{displayStatusMessage}</p>
        {latestStreamUpdate && stage !== "complete" ? (
          <p className="text-xs text-muted-foreground/80">
            {(() => {
              const { tag, message } = splitTaggedLine(latestStreamUpdate);
              return tag ? `${tag}: ${message}` : message;
            })()}
          </p>
        ) : null}

        <Collapsible open={streamExpanded} onOpenChange={setStreamExpanded}>
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="mb-2 flex w-full items-center justify-between text-left text-xs text-muted-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Activity className={cn("h-3.5 w-3.5", isStreaming && "text-primary")} />
                  AI stream
                </span>
                <span className="inline-flex items-center gap-1">
                  {effectiveRawLines.length}
                  {streamExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="max-h-48 overflow-y-auto rounded-md border border-border/40 bg-background/70">
                {streamLinesForDisplay.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground">
                    Waiting for stream events...
                  </div>
                ) : (
                  streamLinesForDisplay.map((line, idx) => {
                    const { tag, message } = splitTaggedLine(line);
                    return (
                      <div
                        key={`${idx}-${line}`}
                        className="border-b border-border/30 px-2.5 py-2 text-xs last:border-b-0"
                      >
                        <div className="flex items-start gap-2">
                          {tag ? (
                            <span className="mt-0.5 shrink-0 rounded border border-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {tag}
                            </span>
                          ) : null}
                          <span className="min-w-0 break-words text-muted-foreground">
                            {message || line}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <Collapsible open={holdingsExpanded} onOpenChange={setHoldingsExpanded}>
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="mb-2 flex w-full items-center justify-between text-left text-xs text-muted-foreground"
              >
                <span>Confirmed Holdings</span>
                <span className="inline-flex items-center gap-1">
                  {holdingsCount}
                {typeof holdingsTotal === "number" && holdingsTotal > 0 ? `/${holdingsTotal}` : ""}
                  {holdingsExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {displayHoldings.length === 0 ? (
                  <div className="rounded-lg border border-border/40 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground">
                    {showConfirmedHoldings
                      ? "No confirmed holdings were returned for this import."
                      : "Confirmed holdings will appear here after parsing completes."}
                  </div>
                ) : (
                  displayHoldings.map((holding, idx) => (
                    <div
                      key={`${holding.symbol || holding.name || "holding"}-${idx}`}
                      className="rounded-lg border border-border/40 bg-background/70 px-2.5 py-2 text-xs"
                    >
                      {(() => {
                        const side = getLiveHoldingPositionSide(holding);
                        const sideClass =
                          side === "short"
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : side === "liability"
                              ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                              : "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
                        const quantityValue =
                          typeof holding.quantity === "number" && Number.isFinite(holding.quantity)
                            ? holding.quantity
                            : null;
                        const quantityLabel =
                          quantityValue === null
                            ? "—"
                            : (side === "short" || side === "liability"
                                ? Math.abs(quantityValue).toLocaleString()
                                : quantityValue.toLocaleString());
                        return (
                          <>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground/90">
                            {holding.symbol || `Holding ${idx + 1}`}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {holding.name || "Security captured from statement"}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide", sideClass)}>
                            {side}
                          </span>
                          {holding.asset_type && (
                            <span className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {holding.asset_type}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>Qty: {quantityLabel}</span>
                        <span>
                          Value:{" "}
                          {typeof holding.market_value === "number"
                            ? `$${holding.market_value.toLocaleString()}`
                            : "—"}
                        </span>
                      </div>
                          </>
                        );
                      })()}
                    </div>
                  ))
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {stage === "error" && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-4">
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              {errorMessage || statusMessage || "Import failed while processing the statement."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRetry && (
                <MorphyButton variant="gradient" size="sm" onClick={onRetry}>
                  Retry Import
                </MorphyButton>
              )}
              {onCancel && (
                <MorphyButton variant="muted" size="sm" onClick={onCancel}>
                  Back
                </MorphyButton>
              )}
            </div>
          </div>
        )}

        {stage === "complete" && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <div className="flex items-center gap-2">
              <Icon icon={CheckCircle2} size="md" className="text-emerald-500" />
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                Successfully extracted portfolio data
              </p>
            </div>
            {holdingsExtracted > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Final holdings extracted: {holdingsExtracted}
                {typeof holdingsTotal === "number" && holdingsTotal > 0 ? ` / ${holdingsTotal}` : ""}
              </p>
            )}
            {onContinue && (
              <MorphyButton
                variant="gradient"
                size="sm"
                className="mt-3"
                onClick={onContinue}
              >
                Review Extracted Portfolio
              </MorphyButton>
            )}
            {onBackToDashboard && (
              <MorphyButton
                variant="muted"
                size="sm"
                className="ml-2 mt-2"
                onClick={onBackToDashboard}
              >
                Cancel
              </MorphyButton>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
