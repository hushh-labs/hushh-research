"use client";

import { useDeferredValue, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  AppStreamPanel,
  type AppStreamProgressItem,
} from "@/components/app-ui/stream-progress-panel";
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
};

const MAX_VISIBLE_THINKING_CHARACTERS = 4_000;
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

function truncateVisibleText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
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
}: AgentTurnStreamPanelProps) {
  // Provider thought summaries can arrive in many tiny SSE frames. Deferring
  // their markdown formatting keeps answer-token rendering responsive.
  const deferredThinkingText = useDeferredValue(thinkingText ?? "");
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
  const visibleThinkingText = useMemo(
    () => truncateVisibleText(deferredThinkingText.trim(), MAX_VISIBLE_THINKING_CHARACTERS),
    [deferredThinkingText]
  );
  const specialistItems = useMemo(() => normalizeSpecialistSources(sources), [sources]);
  const thinkingContent = visibleThinkingText ? (
    <div
      className="max-h-28 overflow-y-auto overscroll-contain pr-1 text-sm leading-6 text-muted-foreground"
      aria-label="Working notes"
    >
      <div className="prose prose-sm max-w-none break-words text-muted-foreground prose-p:my-1.5 prose-headings:my-2 prose-headings:text-foreground prose-strong:text-foreground prose-li:my-0.5 dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{visibleThinkingText}</ReactMarkdown>
      </div>
    </div>
  ) : undefined;

  return (
    <AppStreamPanel
      title="Agent response stream"
      progressItems={progressItems}
      thinkingContent={thinkingContent}
      evidenceItems={specialistItems}
      evidenceTitle="Sources consulted"
      responseText={responseText}
      response={response}
      isStreaming={isStreaming}
      isError={isError}
      opportunities={opportunities}
      className={className}
    />
  );
}
