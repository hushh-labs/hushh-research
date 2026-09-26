"use client";

import { useMemo, type ReactNode } from "react";

import {
  AppStreamPanel,
  type AppStreamProgressItem,
} from "@/components/app-ui/stream-progress-panel";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { AgentStructuredExperienceView, type InformationRequestSubmissionReceipt } from "@/components/agent/agent-structured-experience";
import type {
  AgentStructuredExperience,
  AgentStructuredExperienceWithPresentation,
} from "@/lib/agent/agui-structured-experiences";
import type { AgentChatToolEvent, AgentSource } from "@/lib/services/agent-chat-client";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";

export type AgentVisibleStreamStatus = "running" | "waiting" | "done" | "blocked" | "error";

export type AgentVisibleStreamEvent = {
  id: string;
  label: string;
  message: string;
  status: AgentVisibleStreamStatus;
  /** App-authored, e.g. "Read" or "Needs review". Never provider text. */
  tag?: string;
  createdAtMs: number;
};

export const PRIVATE_MEMORY_PREPARATION_EVENT_ID = "private-memory-preparation";

export type AgentTurnStreamPanelProps = {
  streamEvents: AgentVisibleStreamEvent[];
  thinkingSummary?: string;
  responseText: string;
  isStreaming: boolean;
  isError?: boolean;
  opportunities?: ReactNode;
  response?: ReactNode;
  className?: string;
  sources?: AgentSource[];
  structuredExperience?: AgentStructuredExperience | null;
  structuredExperiences?: Array<{
    id: string;
    experience: AgentStructuredExperienceWithPresentation;
  }>;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
  onInformationRequestSubmitted?: (activityId: string, receipt: InformationRequestSubmissionReceipt) => Promise<void>;
};

const MAX_VISIBLE_SOURCES = 8;

const SOURCE_SUMMARIES: Record<string, { badge: string; message: string }> = {
  agent_email: { badge: "Specialist", message: "Mail assistant consulted." },
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
      : toolEvent.status === "waiting"
        ? "waiting"
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
    ...(toolEvent.tag ? { tag: toolEvent.tag } : {}),
    createdAtMs: nowMs,
  };
}

export function AgentTurnStreamPanel({
  streamEvents,
  thinkingSummary = "",
  responseText,
  isStreaming,
  isError = false,
  opportunities,
  response,
  className,
  sources = [],
  structuredExperience = null,
  structuredExperiences = [],
  onOpenConnections,
  onInformationRequestSubmitted,
}: AgentTurnStreamPanelProps) {
  const progressItems = useMemo<AppStreamProgressItem[]>(
    () =>
      streamEvents.map((event) => ({
        id: event.id,
        label: event.label,
        message: event.message,
        status: event.status,
        tag: event.tag,
      })),
    [streamEvents]
  );
  const specialistItems = useMemo(() => normalizeSpecialistSources(sources), [sources]);
  const preparingPrivateMemory = streamEvents.some(
    (event) =>
      event.id === PRIVATE_MEMORY_PREPARATION_EVENT_ID &&
      event.status === "running",
  );
  const experienceItems = useMemo(
    () =>
      structuredExperiences.length > 0
        ? structuredExperiences
        : structuredExperience
          ? [{ id: "legacy-structured-experience", experience: structuredExperience }]
          : [],
    [structuredExperience, structuredExperiences],
  );

  return (
    <AppStreamPanel
      title="One activity"
      progressItems={[...progressItems, ...specialistItems]}
      responseText={responseText}
      response={response}
      thinkingTitle="Thinking summary"
      thinkingContent={thinkingSummary ? (
        <div className="max-h-44 min-h-0 overflow-y-auto overscroll-contain text-sm text-muted-foreground">
          {/* Provider summaries are markdown ("**Heading**" then a paragraph);
              render them with the same renderer as the answer. */}
          <AgentMarkdown text={thinkingSummary} className="[&_strong]:text-foreground" />
        </div>
      ) : undefined}
      structuredContent={
        experienceItems.length > 0 ? (
          <div className="space-y-3">
            {experienceItems.map(({ id, experience }) => (
              <AgentStructuredExperienceView
                key={id}
                experience={experience}
                onOpenConnections={onOpenConnections}
                onInformationRequestSubmitted={onInformationRequestSubmitted
                  ? (receipt) => onInformationRequestSubmitted(id, receipt) : undefined}
              />
            ))}
          </div>
        ) : null
      }
      responsePendingLabel={
        preparingPrivateMemory ? undefined : "One is preparing your response."
      }
      isStreaming={isStreaming}
      isError={isError}
      opportunities={opportunities}
      className={className}
    />
  );
}
