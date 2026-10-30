"use client";

import { ReactNode } from "react";
import { StreamingProgressView } from "./views/streaming-progress-view";
import type { AgentState } from "./debate-stream-view";

interface AgentAnalysisCardProps {
  agentName: string;
  icon: ReactNode;
  color: string; // Tailwind class e.g. "text-blue-500"
  state: AgentState;
  disableStreaming?: boolean;
  compactMode?: boolean;
}

export function AgentAnalysisCard({
  agentName,
  icon,
  color,
  state,
  disableStreaming = false,
  compactMode = false,
}: AgentAnalysisCardProps) {
  // Color is now passed as a tailwind class directly (text-blue-500, etc.)
  const accentClass = color.startsWith("text-") ? color : "text-primary";

  return (
    <StreamingProgressView
      stage={state.stage}
      title={agentName}
      icon={icon}
      streamedText={state.text}
      thoughts={state.thoughts}
      errorMessage={state.error}
      accentColor={accentClass}
      className="h-full"
      // Pass through all KPI fields
      recommendation={state.recommendation}
      confidence={state.confidence}
      sources={state.sources}
      keyMetrics={state.keyMetrics}
      quantMetrics={state.quantMetrics}
      businessMoat={state.businessMoat}
      financialResilience={state.financialResilience}
      growthEfficiency={state.growthEfficiency}
      bullCase={state.bullCase}
      bearCase={state.bearCase}
      sentimentScore={state.sentimentScore}
      keyCatalysts={state.keyCatalysts}
      valuationMetrics={state.valuationMetrics}
      peerComparison={state.peerComparison}
      priceTargets={state.priceTargets}
      disableStreaming={disableStreaming}
      compactMode={compactMode}
    />
  );
}
