"use client";

import { useMemo, type ReactNode } from "react";

import {
  AppStreamPanel,
  type AppStreamProgressItem,
} from "@/components/app-ui/stream-progress-panel";
import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import type { AgentStructuredExperience } from "@/lib/agent/agui-structured-experiences";
import type { AgentChatToolEvent, AgentSource } from "@/lib/services/agent-chat-client";

export type AgentVisibleStreamStatus = "running" | "done" | "blocked" | "error";

export type AgentVisibleStreamEvent = {
  id: string;
  label: string;
  message: string;
  status: AgentVisibleStreamStatus;
  createdAtMs: number;
};

export type AgentTurnStreamPanelProps = {
  streamEvents: AgentVisibleStreamEvent[];
  responseText: string;
  isStreaming: boolean;
  isError?: boolean;
  opportunities?: ReactNode;
  response?: ReactNode;
  className?: string;
  thinkingText?: string;
  sources?: AgentSource[];
  structuredExperience?: AgentStructuredExperience | null;
};

const MAX_VISIBLE_SOURCES = 8;

const SOURCE_SUMMARIES: Record<string, { badge: string; message: string }> = {
  agent_email: { badge: "Specialist", message: "Email assistant consulted." },
  agent_location: { badge: "Specialist", message: "Location assistant consulted." },
  agent_connected_systems: { badge: "Specialist", message: "Connections assistant consulted." },
  agent_connections: { badge: "Specialist", message: "Connections assistant consulted." },
  agent_nav: { badge: "Specialist", message: "Consent assistant consulted." },
  agent_kai: { badge: "Specialist", message: "Finance specialist consulted." },
  web: { badge: "Web", message: "Public web research consulted." },
};

function cleanVisibleText(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function normalizeToolLabel(toolEvent: AgentChatToolEvent): string {
  return cleanVisibleText(toolEvent.label, "Action");
}

function normalizeSpecialistSources(sources: AgentSource[]): AppStreamProgressItem[] {
  const seen = new Set<string>();
  const visible: AppStreamProgressItem[] = [];

  for (const source of sources) {
    const label = cleanVisibleText(source.label, "");
    if (!label) continue;
    const sourceKey = cleanVisibleText(source.agentId, label).toLowerCase();
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    const summary = SOURCE_SUMMARIES[sourceKey] ?? {
      badge: "Specialist",
      message: "A specialist was consulted for this answer.",
    };
    visible.push({
      id: `specialist-${sourceKey}`,
      label,
      message: summary.message,
      status: "done",
      badge: summary.badge,
    });
    if (visible.length === MAX_VISIBLE_SOURCES) break;
  }

  return visible;
}

export function agentToolEventToVisibleStreamEvent(
  phase: "start" | "waiting" | "result",
  toolEvent: AgentChatToolEvent,
  nowMs = Date.now()
): AgentVisibleStreamEvent {
  const status: AgentVisibleStreamStatus =
    toolEvent.execution === "blocked" || toolEvent.status === "blocked"
      ? "blocked"
      : phase === "result"
        ? "done"
        : "running";
  const fallback =
    phase === "start"
      ? "Preparing the next step."
      : phase === "waiting"
        ? "Working on that."
        : status === "blocked"
          ? "That step needs attention."
          : "Step complete.";
  return {
    id: toolEvent.callId || `${normalizeToolLabel(toolEvent)}-${phase}-${nowMs}`,
    label: normalizeToolLabel(toolEvent),
    message: cleanVisibleText(toolEvent.message, fallback),
    status,
    createdAtMs: nowMs,
  };
}

export function AgentTurnStreamPanel({
  streamEvents,
  responseText,
  isStreaming,
  isError = false,
  opportunities,
  response,
  className,
  thinkingText,
  sources = [],
  structuredExperience = null,
}: AgentTurnStreamPanelProps) {
  const progressItems = useMemo<AppStreamProgressItem[]>(
    () =>
      streamEvents.map((event) => ({
        id: event.id,
        label: event.label,
        message: event.message,
        status: event.status,
      })),
    [streamEvents]
  );
  const specialistItems = useMemo(() => normalizeSpecialistSources(sources), [sources]);
  // Provider reasoning is rendered again (founder directive 2026-09-02): the
  // owner asked to see the agent think. It stays inside the activity panel,
  // below the sanitized tool/memory/specialist lifecycle facts, so it is
  // available without competing with the answer.

  return (
    <AppStreamPanel
      title="One activity"
      progressItems={[...progressItems, ...specialistItems]}
      responseText={responseText}
      response={response}
      structuredContent={
        structuredExperience ? (
          <AgentStructuredExperienceView experience={structuredExperience} />
        ) : null
      }
      thinkingTitle="One is thinking"
      thinkingContent={
        thinkingText && thinkingText.trim() ? (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {thinkingText.trim()}
          </p>
        ) : null
      }
      responsePendingLabel="One is preparing your response."
      isStreaming={isStreaming}
      isError={isError}
      opportunities={opportunities}
      className={className}
    />
  );
}
