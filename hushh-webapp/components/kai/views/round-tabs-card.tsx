"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "@/components/icons";
import { AgentAnalysisCard } from "../agent-analysis-card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { AgentState } from "../debate-stream-view";
import { cn } from "@/lib/utils";

interface RoundTabsCardProps {
  roundNumber: number; title: string; description?: string; isCollapsed: boolean;
  onToggleCollapse: () => void; activeAgent?: string; agentStates: Record<string, AgentState>;
  onTabChange?: (value: string) => void; className?: string;
}
const agents = [
  { id: "fundamental", name: "Fundamental", description: "Business quality and financial evidence" },
  { id: "sentiment", name: "Sentiment", description: "News and market context" },
  { id: "valuation", name: "Valuation", description: "Pricing assumptions and trade-offs" },
] as const;

/** Existing analyst output, disclosed as rows instead of another navigation level. */
export function RoundTabsCard({ roundNumber, title, description, isCollapsed, onToggleCollapse, agentStates, onTabChange, className }: RoundTabsCardProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return <section className={cn("min-w-0", className)} aria-label={title}>
    <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left" onClick={onToggleCollapse} aria-expanded={!isCollapsed}>
      <span className="min-w-0"><span className="block text-sm font-semibold">{title}</span>{description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}</span>
      {isCollapsed ? <ChevronDown className="size-4 shrink-0" /> : <ChevronUp className="size-4 shrink-0" />}
    </button>
    {!isCollapsed ? <div className="divide-y divide-border">
      {agents.map(agent => {
        const state: AgentState = agentStates[agent.id] || { stage: "idle", text: "", thoughts: [] };
        return <Collapsible key={agent.id} open={expanded[agent.id] ?? false} onOpenChange={open => {
          setExpanded(previous => ({ ...previous, [agent.id]: open }));
          if (open) onTabChange?.(agent.id);
        }}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex min-h-14 w-full items-center gap-3 py-2 text-left" aria-label={agent.name + " · round " + roundNumber}>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{agent.name}</span><span className="block text-xs text-muted-foreground">{agent.description}</span></span>
              <span className="text-xs text-muted-foreground">{state.stage === "complete" ? "Complete" : state.stage === "active" ? "Analyzing" : state.stage === "error" ? "Unavailable" : "Waiting"}</span>
              {expanded[agent.id] ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent><AgentAnalysisCard agentName={agent.name + " Agent"} icon={null} color="text-primary" state={state} disableStreaming={false} compactMode /></CollapsibleContent>
        </Collapsible>;
      })}
    </div> : null}
  </section>;
}
