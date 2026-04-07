// components/kai/views/analysis-view.tsx

/**
 * Analysis View - Display debate engine results
 *
 * Features:
 * - Decision card with BUY/HOLD/REDUCE recommendation
 * - Confidence score with reliability badge
 * - Agent insights tabs (Fundamental, Sentiment, Valuation)
 * - Key metrics and sources
 * - Back to Dashboard button
 */

"use client";

import { useState } from "react";
import { ArrowLeft, TrendingUp, TrendingDown, Minus, Search, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_MEASURE_STYLES } from "@/components/app-ui/app-page-shell";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";

import { Badge } from "@/components/ui/badge";

// =============================================================================
// TYPES
// =============================================================================

export interface AnalysisResult {
  symbol: string;
  decision: "BUY" | "HOLD" | "REDUCE";
  confidence: number;
  summary: string;
  fundamentalInsights?: string;
  sentimentInsights?: string;
  valuationInsights?: string;
}

interface AnalysisViewProps {
  result: AnalysisResult;
  onBack: () => void;
  onAnalyzeAnother?: (symbol: string) => void;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getDecisionColor(decision: string): string {
  switch (decision) {
    case "BUY":
      return "text-emerald-500";
    case "REDUCE":
      return "text-red-500";
    default:
      return "text-amber-500";
  }
}

function getDecisionBgColor(decision: string): string {
  switch (decision) {
    case "BUY":
      return "bg-emerald-500/10";
    case "REDUCE":
      return "bg-red-500/10";
    default:
      return "bg-amber-500/10";
  }
}

/** Renders the icon for a decision (no component created during render). */
function renderDecisionIcon(decision: string, className?: string): React.ReactNode {
  if (decision === "BUY") return <TrendingUp className={className} />;
  if (decision === "REDUCE") return <TrendingDown className={className} />;
  return <Minus className={className} />;
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High Confidence";
  if (confidence >= 0.6) return "Moderate Confidence";
  return "Low Confidence";
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "text-emerald-500";
  if (confidence >= 0.6) return "text-amber-500";
  return "text-red-500";
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function AnalysisView({
  result,
  onBack,
  onAnalyzeAnother,
}: AnalysisViewProps) {
  const [activeTab, setActiveTab] = useState<"fundamental" | "sentiment" | "valuation">("fundamental");
  const [searchInput, setSearchInput] = useState("");

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim() && onAnalyzeAnother) {
      onAnalyzeAnother(searchInput.toUpperCase());
      setSearchInput("");
    }
  };

  return (
    <div className="flex flex-col h-full bg-transparent relative">
      {/* Header - Masked gradient + sticky nav */}
      <div className="flex-none sticky top-0 z-10 overflow-hidden mb-4">
        {/* Root layout owns the app gradient; keep header readable with a subtle surface only. */}
        <div className="absolute inset-0 backdrop-blur-md bg-background/40" />

        {/* Content */}
        <div className="mx-auto w-full relative pt-3 pb-2" style={APP_MEASURE_STYLES.reading}>
          <div className="flex items-center gap-4">
            <MorphyButton
              variant="muted"
              size="icon"
              onClick={onBack}
              className="h-10 w-10 rounded-full bg-background/50 hover:bg-background/80"
              aria-label="Back to Portfolio"
              icon={{ icon: ArrowLeft }}
            />

            <div>
              <h1 className="text-2xl font-bold tracking-tighter">{result.symbol}</h1>
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Investment Analysis</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full space-y-6 pb-36" style={APP_MEASURE_STYLES.reading}>

      {/* Decision Card */}
      <SurfaceCard>
        <SurfaceCardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "w-12 h-12 rounded-full flex items-center justify-center",
                  getDecisionBgColor(result.decision)
                )}
              >
                {renderDecisionIcon(
                  result.decision,
                  cn("w-6 h-6", getDecisionColor(result.decision))
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Recommendation</p>
                <p
                  className={cn(
                    "text-2xl font-bold",
                    getDecisionColor(result.decision)
                  )}
                >
                  {result.decision}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Confidence</p>
              <p
                className={cn(
                  "text-xl font-semibold",
                  getConfidenceColor(result.confidence)
                )}
              >
                {(result.confidence * 100).toFixed(0)}%
              </p>
              <Badge
                variant="outline"
                className={cn("mt-1", getConfidenceColor(result.confidence))}
              >
                {getConfidenceLabel(result.confidence)}
              </Badge>
            </div>
          </div>

          <p className="text-muted-foreground">{result.summary}</p>
        </SurfaceCardContent>
      </SurfaceCard>

      {/* Agent Insights Tabs */}
      <SurfaceCard>
        <SurfaceCardHeader className="pb-0">
          <SurfaceCardTitle className="text-base">Agent Insights</SurfaceCardTitle>
        </SurfaceCardHeader>
        <SurfaceCardContent className="p-4">
          {/* Tab Buttons */}
          <div className="flex gap-2 mb-4">
            {[
              { key: "fundamental", label: "Fundamental" },
              { key: "sentiment", label: "Sentiment" },
              { key: "valuation", label: "Valuation" },
            ].map((tab) => (
              <MorphyButton
                key={tab.key}
                variant={activeTab === tab.key ? "gradient" : "muted"}
                size="sm"
                onClick={() => setActiveTab(tab.key as typeof activeTab)}
                className="flex-1"
              >
                {tab.label}
              </MorphyButton>
            ))}
          </div>


          {/* Tab Content */}
          <div className="min-h-[120px] p-4 rounded-lg bg-muted/50">
            {activeTab === "fundamental" && (
              <p className="text-sm">
                {result.fundamentalInsights || "Fundamental analysis evaluates the company's financial health, including revenue growth, profit margins, debt levels, and competitive position."}
              </p>
            )}
            {activeTab === "sentiment" && (
              <p className="text-sm">
                {result.sentimentInsights || "Sentiment analysis examines market perception, news coverage, social media trends, and analyst opinions about the stock."}
              </p>
            )}
            {activeTab === "valuation" && (
              <p className="text-sm">
                {result.valuationInsights || "Valuation analysis compares the stock's current price to its intrinsic value using metrics like P/E ratio, DCF models, and peer comparisons."}
              </p>
            )}
          </div>
        </SurfaceCardContent>
      </SurfaceCard>

      {/* Disclaimer */}
      <SurfaceCard tone="warning">
        <SurfaceCardContent className="p-4">
          <div className="flex items-start gap-3">
            <Icon
              icon={AlertTriangle}
              size="md"
              className="text-amber-500 shrink-0 mt-0.5"
            />
            <div>
              <p className="text-sm font-medium mb-1">Investment Disclaimer</p>
              <p className="text-xs text-muted-foreground">
                This analysis is for informational purposes only and does not constitute
                financial advice. Past performance is not indicative of future results.
                Always conduct your own research and consult with a qualified financial
                advisor before making investment decisions.
              </p>
            </div>
          </div>
        </SurfaceCardContent>
      </SurfaceCard>

      {/* Analyze Another Stock */}
      {onAnalyzeAnother && (
        <SurfaceCard>
          <SurfaceCardContent className="p-4">
            <p className="text-sm font-medium mb-3">Analyze Another Stock</p>
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="flex-1 relative">
                <Icon
                  icon={Search}
                  size="sm"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value.toUpperCase())}
                  placeholder="Enter ticker (e.g., AAPL)"
                  maxLength={5}
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background outline-none focus:border-primary transition-colors"
                />
              </div>
              <MorphyButton 
                type="submit" 
                variant="gradient"
                size="sm"
                disabled={!searchInput.trim()}
              >
                Analyze
              </MorphyButton>
            </form>


          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {/* Back Button */}
      <div className="text-center">
        <MorphyButton 
          variant="muted" 
          effect="glass" 
          onClick={onBack}
        >
          Back to Portfolio
        </MorphyButton>
      </div>

    </div>
    </div>
  );
}
