"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/morphy-ux";
import { StreamingAccordion } from "@/lib/morphy-ux/streaming-accordion";
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Shield,
  Zap,
  Target,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Link2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Icon } from "@/lib/morphy-ux/ui";

export type StreamingStage = "idle" | "active" | "complete" | "error";

// ============================================================================
// Types
// ============================================================================

export interface StreamingProgressViewProps {
  stage: StreamingStage;
  title: string;
  icon?: React.ReactNode;
  streamedText: string;
  thoughts?: string[];
  errorMessage?: string;
  statusMessage?: string;
  className?: string;
  accentColor?: string;
  // Rich KPI data
  recommendation?: string;
  confidence?: number;
  sources?: string[];
  keyMetrics?: Record<string, any>;
  quantMetrics?: Record<string, any>;
  businessMoat?: string;
  financialResilience?: string;
  growthEfficiency?: string;
  bullCase?: string;
  bearCase?: string;
  sentimentScore?: number;
  keyCatalysts?: string[];
  valuationMetrics?: Record<string, any>;
  peerComparison?: Record<string, any>;
  priceTargets?: Record<string, any>;
  disableStreaming?: boolean;
  compactMode?: boolean;
}

// ============================================================================
// Source URL Helpers
// ============================================================================

const KNOWN_SOURCE_URLS: Record<string, string> = {
  "yahoo finance": "https://finance.yahoo.com",
  "sec edgar": "https://www.sec.gov/cgi-bin/browse-edgar",
  "google finance": "https://www.google.com/finance",
  "bloomberg": "https://www.bloomberg.com",
  "reuters": "https://www.reuters.com",
  "finnhub": "https://finnhub.io",
  "pmp/fmp": "https://site.financialmodelingprep.com/developer/docs",
  "financial modeling prep": "https://site.financialmodelingprep.com/developer/docs",
};

function parseSourceUrl(source: string): { text: string; url: string | null } {
  const urlMatch = source.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) {
    return { text: source.replace(urlMatch[0], "").trim() || urlMatch[0], url: urlMatch[0] };
  }
  const lower = source.toLowerCase();
  for (const [key, url] of Object.entries(KNOWN_SOURCE_URLS)) {
    if (lower.includes(key)) return { text: source, url };
  }
  return { text: source, url: null };
}

// ============================================================================
// Helpers
// ============================================================================

/** Filter out null, undefined, NaN, "N/A" values */
function isValidValue(v: any): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number" && Number.isNaN(v)) return false;
  if (typeof v === "string" && (v === "N/A" || v.trim() === "")) return false;
  if (typeof v === "object") return false;
  return true;
}

function isNonEmptyString(v: any): boolean {
  return typeof v === "string" && v.trim().length > 0 && v.trim() !== "N/A";
}

// ============================================================================
// KPI Sub-Components
// ============================================================================

function RecommendationBadge({ recommendation, confidence }: { recommendation: string; confidence?: number }) {
  const rec = recommendation?.toLowerCase() || "";
  const variant = rec === "buy" || rec === "bullish" || rec === "undervalued" ? "emerald" : rec === "reduce" || rec === "sell" || rec === "bearish" || rec === "overvalued" ? "red" : "blue";
  const colors = {
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    red: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  };

  return (
    <div className="flex items-center justify-between">
      <Badge variant="outline" className={cn("font-bold uppercase text-xs tracking-wider px-3 py-1", colors[variant])}>
        {recommendation}
      </Badge>
      {confidence !== undefined && confidence !== null && !Number.isNaN(confidence) && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Confidence</span>
          <Progress value={confidence * 100} className="w-16 h-1.5" />
          <span className="text-xs font-medium">{Math.round(confidence * 100)}%</span>
        </div>
      )}
    </div>
  );
}

function MetricsGrid({ metrics, title }: { metrics: Record<string, any>; title: string }) {
  const entries = useMemo(() => {
    return Object.entries(metrics).filter(([, v]) => isValidValue(v)).slice(0, 8);
  }, [metrics]);

  if (entries.length === 0) return null;

  const formatValue = (value: any): string => {
    if (typeof value === "number") {
      if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
      if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
      if (Math.abs(value) < 1 && value !== 0) return `${(value * 100).toFixed(1)}%`;
      return value.toFixed(2);
    }
    return String(value);
  };

  const formatLabel = (key: string): string =>
    key.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex justify-between items-center py-1 px-2 rounded-md bg-muted/20">
            <span className="text-[10px] text-muted-foreground truncate mr-2">{formatLabel(key)}</span>
            <span className="text-[10px] font-medium whitespace-nowrap">{formatValue(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SentimentGauge({ score }: { score: number }) {
  const normalized = ((score + 1) / 2) * 100;
  const label = score > 0.3 ? "Bullish" : score < -0.3 ? "Bearish" : "Neutral";
  const color = score > 0.3 ? "text-emerald-500" : score < -0.3 ? "text-red-500" : "text-blue-500";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sentiment Score</p>
        <span className={cn("text-sm font-bold", color)}>{label}</span>
      </div>
      <div className="relative h-2 bg-muted/30 rounded-full overflow-hidden">
        <div className="absolute inset-0 flex">
          <div className="flex-1 bg-red-500/20" />
          <div className="flex-1 bg-blue-500/20" />
          <div className="flex-1 bg-emerald-500/20" />
        </div>
        <div
          className={cn("absolute top-0 h-full w-2.5 rounded-full transition-all duration-500", score > 0.3 ? "bg-emerald-500" : score < -0.3 ? "bg-red-500" : "bg-blue-500")}
          style={{ left: `calc(${normalized}% - 5px)` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>Bearish</span>
        <span>Neutral</span>
        <span>Bullish</span>
      </div>
    </div>
  );
}

function CatalystChips({ catalysts }: { catalysts: string[] }) {
  const valid = catalysts.filter((c) => isNonEmptyString(c));
  if (valid.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Key Catalysts</p>
      <div className="flex flex-wrap gap-1.5">
        {valid.slice(0, 6).map((c, i) => (
          <Badge key={i} variant="outline" className="text-[10px] bg-primary/5 border-primary/20">
            <Icon icon={Zap} size={10} className="mr-1" />
            {c.length > 40 ? c.slice(0, 40) + "..." : c}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function BullBearCase({ bullCase, bearCase }: { bullCase?: string; bearCase?: string }) {
  const hasBull = isNonEmptyString(bullCase);
  const hasBear = isNonEmptyString(bearCase);
  if (!hasBull && !hasBear) return null;
  return (
    <div className="grid grid-cols-1 gap-1.5">
      {hasBull && (
        <div className="p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Icon icon={TrendingUp} size={12} className="text-emerald-500" />
            <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">Bull Case</span>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{bullCase}</p>
        </div>
      )}
      {hasBear && (
        <div className="p-2 rounded-lg bg-red-500/5 border border-red-500/20">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Icon icon={TrendingDown} size={12} className="text-red-500" />
            <span className="text-[10px] font-semibold text-red-600 dark:text-red-400">Bear Case</span>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{bearCase}</p>
        </div>
      )}
    </div>
  );
}

function PriceTargets({ targets }: { targets: Record<string, any> }) {
  const entries = useMemo(() => {
    return Object.entries(targets).filter(([, v]) => isValidValue(v)).slice(0, 3);
  }, [targets]);
  if (entries.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Icon icon={Target} size="xs" />
        Price Targets
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="text-center p-1.5 rounded-md bg-muted/20">
            <p className="text-[10px] text-muted-foreground capitalize">{key.replace(/_/g, " ")}</p>
            <p className="text-xs font-bold">${typeof value === "number" ? value.toFixed(2) : value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourcesList({ sources }: { sources: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const valid = sources.filter((s) => isNonEmptyString(s));
  if (valid.length === 0) return null;

  const visibleSources = expanded ? valid : valid.slice(0, 3);

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
      >
        <Icon icon={ExternalLink} size={12} />
        Sources ({valid.length})
        {valid.length > 3 &&
          (expanded ? <Icon icon={ChevronUp} size={12} /> : <Icon icon={ChevronDown} size={12} />)}
      </button>
      <div className="space-y-1">
        {visibleSources.map((src, i) => {
          const { text, url } = parseSourceUrl(src);
          if (url) {
            return (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary/80 hover:text-primary truncate pl-2 border-l-2 border-primary/20 flex items-center gap-1 transition-colors"
              >
                <Icon icon={Link2} size={10} className="shrink-0" />
                <span className="truncate">{text || url}</span>
              </a>
            );
          }
          return (
            <p key={i} className="text-[10px] text-muted-foreground truncate pl-2 border-l-2 border-primary/20">
              {text}
            </p>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component - No Card wrapper (parent RoundTabsCard provides context)
// ============================================================================

export function StreamingProgressView({
  stage,
  title,
  icon,
  streamedText,
  thoughts = [],
  errorMessage,
  statusMessage,
  className,
  accentColor = "text-primary",
  recommendation,
  confidence,
  sources,
  keyMetrics,
  quantMetrics,
  businessMoat,
  financialResilience,
  growthEfficiency,
  bullCase,
  bearCase,
  sentimentScore,
  keyCatalysts,
  valuationMetrics,
  peerComparison,
  priceTargets,
  disableStreaming = false,
  compactMode = false,
}: StreamingProgressViewProps) {
  const isActive = stage === "active";
  const isComplete = stage === "complete";
  const isError = stage === "error";

  const hasKpiData =
    isComplete &&
    (isNonEmptyString(recommendation) ||
      keyMetrics ||
      quantMetrics ||
      (sentimentScore !== undefined && sentimentScore !== null) ||
      valuationMetrics ||
      isNonEmptyString(bullCase) ||
      isNonEmptyString(bearCase));

  const thoughtsText = useMemo(() => {
    if (thoughts.length === 0) return "";
    return thoughts.map((t, i) => `[${i + 1}] **${t}**`).join("\n");
  }, [thoughts]);
  const reasoningText = streamedText || thoughtsText;

  return (
    <div className={cn("w-full transition-all duration-200 space-y-3", className)}>
      {/* Status line - compact, no redundant title */}
      <div className="flex items-center gap-2">
        <div className={cn("transition-colors duration-200 shrink-0", isActive ? accentColor : isComplete ? "text-emerald-500" : isError ? "text-red-500" : "text-muted-foreground")}>
          {isComplete ? (
            <Icon icon={CheckCircle2} size="sm" />
          ) : isError ? (
            <Icon icon={AlertCircle} size="sm" />
          ) : (
            icon || <Icon icon={Loader2} size="sm" className={cn(isActive && "animate-spin")} />
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {statusMessage || (isActive ? "Live update..." : isComplete ? "Complete" : isError ? "Failed" : "Waiting...")}
        </span>
      </div>

      {/* AI Thoughts (Reasoning) - Show streamed text during active, thoughts array when complete */}
      {(isActive || thoughts.length > 0 || streamedText) && (
        <StreamingAccordion
          id={`thoughts-${title.toLowerCase().replace(/\s+/g, "-")}`}
          title="Reasoning"
          text={reasoningText}
          isStreaming={!disableStreaming && isActive} // Disable streaming animation if requested
          isComplete={isComplete}
          autoCollapseOnComplete={false}
          icon={isComplete ? "brain" : "spinner"}
          className="border-primary/5 bg-primary/5"
          defaultExpanded={compactMode || isActive}
        />
      )}

      {/* KPI Section */}
      {!compactMode && hasKpiData && (
        <div className="space-y-2.5">
          <Separator className="opacity-50" />

          {isNonEmptyString(recommendation) && (
            <RecommendationBadge recommendation={recommendation!} confidence={confidence} />
          )}

          {keyMetrics && <MetricsGrid metrics={keyMetrics} title="Key Metrics" />}
          {quantMetrics && <MetricsGrid metrics={quantMetrics} title="Quantitative Metrics" />}

          {isNonEmptyString(businessMoat) && (
            <div className="p-2 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon icon={Shield} size={12} className="text-blue-500" />
                <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">Business Moat</span>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">{businessMoat}</p>
            </div>
          )}

          {(isNonEmptyString(financialResilience) || isNonEmptyString(growthEfficiency)) && (
            <div className="grid grid-cols-2 gap-1.5">
              {isNonEmptyString(financialResilience) && (
                <div className="p-1.5 rounded-md bg-muted/20">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Financial Resilience</p>
                  <p className="text-[10px] font-medium mt-0.5">{financialResilience}</p>
                </div>
              )}
              {isNonEmptyString(growthEfficiency) && (
                <div className="p-1.5 rounded-md bg-muted/20">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Growth Efficiency</p>
                  <p className="text-[10px] font-medium mt-0.5">{growthEfficiency}</p>
                </div>
              )}
            </div>
          )}

          <BullBearCase bullCase={bullCase} bearCase={bearCase} />

          {sentimentScore !== undefined && sentimentScore !== null && !Number.isNaN(sentimentScore) && (
            <SentimentGauge score={sentimentScore} />
          )}
          {keyCatalysts && <CatalystChips catalysts={keyCatalysts} />}

          {valuationMetrics && <MetricsGrid metrics={valuationMetrics} title="Valuation Metrics" />}
          {peerComparison && <MetricsGrid metrics={peerComparison} title="Peer Comparison" />}
          {priceTargets && <PriceTargets targets={priceTargets} />}

          {sources && sources.length > 0 && <SourcesList sources={sources} />}
        </div>
      )}

      {/* Error Display */}
      {isError && errorMessage && (
        <div className="p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="flex items-center gap-2 mb-0.5">
            <Icon icon={AlertTriangle} size={12} className="text-red-500" />
            <span className="text-[10px] font-semibold text-red-500">Error Details</span>
          </div>
          <p className="text-[10px] text-red-500/80">{errorMessage}</p>
        </div>
      )}
    </div>
  );
}
