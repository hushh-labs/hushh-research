"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Card as MorphyCard,
  CardContent as MorphyCardContent,
  CardHeader as MorphyCardHeader,
  CardTitle as MorphyCardTitle,
} from "@/lib/morphy-ux/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock,
  Search,
  Heart,
  Calculator,
  AlertCircle,
} from "lucide-react";
import { AgentAnalysisCard } from "../agent-analysis-card";
import { cn } from "@/lib/morphy-ux";
import { Badge } from "@/components/ui/badge";
import type { AgentState } from "../debate-stream-view";
import { Icon } from "@/lib/morphy-ux/ui";

// ============================================================================
// Types
// ============================================================================

interface RoundTabsCardProps {
  roundNumber: number;
  title: string;
  description?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  activeAgent?: string; // "fundamental" | "sentiment" | "valuation"
  agentStates: Record<string, AgentState>;
  onTabChange?: (value: string) => void;
  className?: string;
}

// Agent ordering - always sequential
const AGENT_ORDER = ["fundamental", "sentiment", "valuation"] as const;

const AGENT_CONFIG = {
  fundamental: {
    label: "Fundamental",
    icon: <Icon icon={Search} size="sm" />,
    color: "text-blue-500",
    bgActive: "bg-blue-500",
    bgDot: "bg-blue-500",
  },
  sentiment: {
    label: "Sentiment",
    icon: <Icon icon={Heart} size="sm" />,
    color: "text-purple-500",
    bgActive: "bg-purple-500",
    bgDot: "bg-purple-500",
  },
  valuation: {
    label: "Valuation",
    icon: <Icon icon={Calculator} size="sm" />,
    color: "text-emerald-500",
    bgActive: "bg-emerald-500",
    bgDot: "bg-emerald-500",
  },
} as const;

// ============================================================================
// Component
// ============================================================================

export function RoundTabsCard({
  roundNumber,
  title,
  description,
  isCollapsed,
  onToggleCollapse,
  activeAgent,
  agentStates,
  onTabChange,
  className,
}: RoundTabsCardProps) {
  const [currentTab, setCurrentTab] = useState<string>(activeAgent || "fundamental");

  useEffect(() => {
    if (activeAgent && activeAgent !== currentTab) {
      setCurrentTab(activeAgent);
    }
  }, [activeAgent, currentTab]);

  const handleTabChange = (val: string) => {
    if (activeAgent) {
      onTabChange?.(val);
      return;
    }
    setCurrentTab(val);
    onTabChange?.(val);
  };

  const isRoundComplete = useMemo(() => {
    return AGENT_ORDER.every((agent) => agentStates[agent]?.stage === "complete");
  }, [agentStates]);

  const completedCount = useMemo(() => {
    return AGENT_ORDER.filter((agent) => agentStates[agent]?.stage === "complete").length;
  }, [agentStates]);

  const hasAnyActivity = useMemo(() => {
    return AGENT_ORDER.some(
      (agent) => agentStates[agent]?.stage === "active" || agentStates[agent]?.stage === "complete"
    );
  }, [agentStates]);

  return (
    <MorphyCard
      showRipple={false}
      className={cn(
        "w-full rounded-2xl border border-border/60 bg-background/70 shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition-all duration-200",
        className
      )}
    >
      <MorphyCardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors duration-200",
                isRoundComplete
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : hasAnyActivity
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-muted/30 text-muted-foreground"
              )}
            >
              {isRoundComplete ? <Icon icon={CheckCircle2} size="sm" /> : roundNumber}
            </div>
            <div>
              <MorphyCardTitle>{title}</MorphyCardTitle>
              {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isRoundComplete ? (
              <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                <Icon icon={CheckCircle2} size={12} className="mr-1" /> Complete
              </Badge>
            ) : hasAnyActivity ? (
              <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30">
                <Icon icon={Clock} size={12} className="mr-1 animate-pulse" /> {completedCount}/3
              </Badge>
            ) : null}
            <MorphyButton
              variant="none"
              effect="fade"
              size="icon-sm"
              showRipple={false}
              onClick={onToggleCollapse}
            >
              {isCollapsed ? <Icon icon={ChevronDown} size="sm" /> : <Icon icon={ChevronUp} size="sm" />}
            </MorphyButton>
          </div>
        </div>
      </MorphyCardHeader>

      {!isCollapsed && (
        <MorphyCardContent>
          <Tabs value={activeAgent || currentTab} onValueChange={handleTabChange} className="w-full">
            <TabsList className="mb-4 grid h-10 w-full grid-cols-3 gap-1">
              {AGENT_ORDER.map((agent) => {
                const config = AGENT_CONFIG[agent];
                const state = agentStates[agent];
                const isAgentComplete = state?.stage === "complete";
                const isAgentActive = state?.stage === "active";
                const isAgentError = state?.stage === "error";

                return (
                  <TabsTrigger
                    key={agent}
                    value={agent}
                    className={cn(
                      "flex h-8 w-full min-w-0 items-center justify-center gap-1 px-1.5 text-center text-[11px] leading-none transition-all duration-200 sm:text-xs",
                      isAgentComplete && "data-[state=active]:text-emerald-700 dark:data-[state=active]:text-emerald-300"
                    )}
                  >
                    <span className="truncate">{config.label}</span>
                    <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center">
                      {isAgentComplete ? (
                        <Icon icon={CheckCircle2} size="xs" className="text-emerald-500" />
                      ) : isAgentError ? (
                        <Icon icon={AlertCircle} size="xs" className="text-red-500" />
                      ) : isAgentActive ? (
                        <span className="relative flex h-2 w-2">
                          <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", config.bgDot)} />
                          <span className={cn("relative inline-flex rounded-full h-2 w-2", config.bgDot)} />
                        </span>
                      ) : null}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {AGENT_ORDER.map((agent) => {
              const config = AGENT_CONFIG[agent];
              return (
                <TabsContent
                  key={agent}
                  value={agent}
                  forceMount
                  className="mt-0 focus-visible:ring-0 data-[state=inactive]:hidden"
                >
                  <AgentAnalysisCard
                    agentName={`${config.label} Agent`}
                    icon={config.icon}
                    color={config.color}
                    state={agentStates[agent] || { stage: "idle", text: "", thoughts: [] }}
                    disableStreaming={false}
                    compactMode
                  />
                </TabsContent>
              );
            })}
          </Tabs>
        </MorphyCardContent>
      )}
    </MorphyCard>
  );
}
