"use client";

import * as React from "react";
import { StreamingProgressView } from "./views/streaming-progress-view";
import type { AgentState } from "./debate-stream-view";

interface AgentAnalysisCardProps {
  agentName: string;
  icon: React.ReactNode;
  color: string; // e.g., "text-blue-500"
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
  // Safe color lookup
  const accentColor = React.useMemo(() =>
    color.startsWith("text-") ? color : "text-primary",
    [color]);

  return (
    <StreamingProgressView
      {...state} // Spread the state to handle all KPI/Metric fields automatically
      stage={state.stage}
      title={agentName}
      icon={icon}
      streamedText={state.text}
      thoughts={state.thoughts}
      errorMessage={state.error}
      accentColor={accentColor}
      className="h-full"
      disableStreaming={disableStreaming}
      compactMode={compactMode}
    />
  );
}