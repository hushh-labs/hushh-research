"use client";

import { useState } from "react";
import { APP_MEASURE_STYLES } from "@/components/app-ui/app-page-shell";
import type { AgentState } from "@/components/kai/debate-stream-view";
import { RoundTabsCard } from "@/components/kai/views/round-tabs-card";
import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";

export function HistoryDebateReplay({ entry }: { entry: AnalysisHistoryEntry }) {
  const [collapsedRounds, setCollapsedRounds] = useState<Record<number, boolean>>({
    1: true,
    2: false,
  });

  if (!entry.debate_transcript) {
    return (
      <div
        className="mx-auto w-full rounded-2xl border border-dashed border-border/60 bg-background/80 p-4 text-sm text-muted-foreground"
        style={APP_MEASURE_STYLES.reading}
      >
        Debate transcript unavailable for this run.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full space-y-4" style={APP_MEASURE_STYLES.reading}>
      <RoundTabsCard
        roundNumber={1}
        title="Initial Deep Analysis"
        description="Agents analyzed source information independently."
        isCollapsed={collapsedRounds[1] ?? true}
        onToggleCollapse={() => setCollapsedRounds((prev) => ({ ...prev, 1: !prev[1] }))}
        agentStates={entry.debate_transcript.round1 as Record<string, AgentState>}
      />
      {entry.debate_transcript.round2 &&
      Object.keys(entry.debate_transcript.round2).length > 0 ? (
        <RoundTabsCard
          roundNumber={2}
          title="Strategic Debate"
          description="Agents challenged and refined positions."
          isCollapsed={collapsedRounds[2] ?? false}
          onToggleCollapse={() => setCollapsedRounds((prev) => ({ ...prev, 2: !prev[2] }))}
          agentStates={entry.debate_transcript.round2 as Record<string, AgentState>}
        />
      ) : null}
    </div>
  );
}
