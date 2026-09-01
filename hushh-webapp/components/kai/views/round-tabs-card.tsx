"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Card as MorphyCard,
  CardContent as MorphyCardContent,
  CardHeader as MorphyCardHeader,
  CardTitle as MorphyCardTitle,
} from "@/lib/morphy-ux/card";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock,
  Search,
  Heart,
  Calculator,
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
  // Once the user manually taps a tab, honor THEIR selection instead of the
  // live stream's `activeAgent`. Without this, tapping "Sentiment" while the
  // fundamental agent is still streaming was ignored (handleTabChange returned
  // early) and the next `activeAgent` prop from polling snapped the tab back --
  // the "bounce". The pin auto-follows again only until the first manual tap.
  const [userPinned, setUserPinned] = useState(false);

  useEffect(() => {
    // Auto-advance to the live agent only while the user has not taken manual
    // control of the tabs.
    if (!userPinned && activeAgent && activeAgent !== currentTab) {
      setCurrentTab(activeAgent);
    }
  }, [activeAgent, currentTab, userPinned]);

  // The displayed tab: the user's pinned choice wins; otherwise follow the
  // live agent, then the local default.
  const selectedTab = userPinned ? currentTab : activeAgent || currentTab;
  const selectedAgent = AGENT_ORDER.includes(selectedTab as (typeof AGENT_ORDER)[number])
    ? (selectedTab as (typeof AGENT_ORDER)[number])
    : "fundamental";
  const selectedConfig = AGENT_CONFIG[selectedAgent];

  const handleTabChange = (val: string) => {
    // A tap always wins and pins, whether or not a live run is streaming, so
    // the selection can never revert under the user.
    setUserPinned(true);
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
        "w-full rounded-[var(--app-card-radius-feature)] border-0 bg-[color:var(--app-card-surface-compact)] shadow-[var(--app-card-shadow-standard)] transition-all duration-200",
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
              aria-label={isCollapsed ? "Expand round details" : "Collapse round details"}
            >
              {isCollapsed ? <Icon icon={ChevronDown} size="sm" /> : <Icon icon={ChevronUp} size="sm" />}
            </MorphyButton>
          </div>
        </div>
      </MorphyCardHeader>

      {!isCollapsed && (
        <MorphyCardContent>
          <SegmentedTabs
            value={selectedAgent}
            onValueChange={handleTabChange}
            options={AGENT_ORDER.map((agent) => ({
              value: agent,
              label: AGENT_CONFIG[agent].label,
            }))}
            className="mb-4 w-full"
            ariaLabel={`${title} analysts`}
          />
          <AgentAnalysisCard
            agentName={`${selectedConfig.label} Agent`}
            icon={selectedConfig.icon}
            color={selectedConfig.color}
            state={agentStates[selectedAgent] || { stage: "idle", text: "", thoughts: [] }}
            disableStreaming={false}
            compactMode
          />
        </MorphyCardContent>
      )}
    </MorphyCard>
  );
}
