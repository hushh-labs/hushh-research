"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";

import {
  AppStreamPanel,
  type AppStreamProgressItem,
} from "@/components/app-ui/stream-progress-panel";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import type {
  AgentStructuredExperience,
  AgentStructuredExperienceWithPresentation,
} from "@/lib/agent/agui-structured-experiences";
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
  structuredExperiences?: Array<{
    id: string;
    experience: AgentStructuredExperienceWithPresentation;
  }>;
};

const MAX_VISIBLE_SOURCES = 8;

function AgentThinkingContent({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const normalizedText = text.trim();

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // Reasoning is a live, bounded detail surface. Keep the newest step in
    // view while it grows; the parent panel remounts closed once response
    // text arrives, so this never competes with the answer.
    container.scrollTop = container.scrollHeight;
  }, [isStreaming, normalizedText]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Thinking details"
      aria-live={isStreaming ? "polite" : undefined}
      className="max-h-44 min-h-0 overflow-y-auto overscroll-contain pr-1 text-xs leading-relaxed text-muted-foreground"
    >
      <AgentMarkdown text={normalizedText} className="text-xs leading-relaxed" />
    </div>
  );
}

const SOURCE_SUMMARIES: Record<string, { badge: string; message: string }> = {
  agent_email: { badge: "Specialist", message: "Email assistant consulted." },
  agent_location: { badge: "Specialist", message: "Location assistant consulted." },
  agent_connected_systems: { badge: "Specialist", message: "Connections assistant consulted." },
  agent_connections: { badge: "Specialist", message: "Connections assistant consulted." },
  agent_nav: { badge: "Specialist", message: "Consent assistant consulted." },
  agent_personal_information: { badge: "Specialist", message: "Memory assistant consulted." },
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

/**
 * A parked browser directive is a continuation of the server tool call that
 * produced it. The transport gives that continuation a synthetic call id, but
 * also carries the originating directive id. Use the origin as the visible
 * activity identity so one invocation evolves from start → waiting → result
 * instead of rendering a second progress row.
 */
function visibleToolEventId(toolEvent: AgentChatToolEvent, nowMs: number): string {
  const originId = cleanVisibleText(toolEvent.directiveId, "");
  if (originId) return originId;
  return cleanVisibleText(
    toolEvent.callId,
    `${normalizeToolLabel(toolEvent)}-${nowMs}`,
  );
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
    id: visibleToolEventId(toolEvent, nowMs),
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
  structuredExperiences = [],
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
  const experienceItems = useMemo(
    () =>
      structuredExperiences.length > 0
        ? structuredExperiences
        : structuredExperience
          ? [{ id: "legacy-structured-experience", experience: structuredExperience }]
          : [],
    [structuredExperience, structuredExperiences],
  );
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
        experienceItems.length > 0 ? (
          <div className="space-y-3">
            {experienceItems.map(({ id, experience }) => (
              <AgentStructuredExperienceView key={id} experience={experience} />
            ))}
          </div>
        ) : null
      }
      thinkingTitle="One is thinking"
      thinkingContent={
        thinkingText && thinkingText.trim() ? (
          <AgentThinkingContent text={thinkingText} isStreaming={isStreaming} />
        ) : null
      }
      thinkingClassName="bg-transparent dark:bg-transparent"
      responsePendingLabel="One is preparing your response."
      isStreaming={isStreaming}
      isError={isError}
      opportunities={opportunities}
      className={className}
    />
  );
}
