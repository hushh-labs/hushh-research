"use client";

import type { ReactNode } from "react";

import {
  AppStreamPanel,
  type AppStreamProgressItem,
} from "@/components/app-ui/stream-progress-panel";
import type { AgentChatToolEvent } from "@/lib/services/agent-chat-client";

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
};

function cleanVisibleText(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function normalizeToolLabel(toolEvent: AgentChatToolEvent): string {
  return cleanVisibleText(toolEvent.label, "Action");
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
}: AgentTurnStreamPanelProps) {
  const progressItems: AppStreamProgressItem[] = streamEvents.map((event) => ({
    id: event.id,
    label: event.label,
    message: event.message,
    status: event.status,
  }));

  return (
    <AppStreamPanel
      title="Agent response stream"
      progressItems={progressItems}
      responseText={responseText}
      response={response}
      isStreaming={isStreaming}
      isError={isError}
      opportunities={opportunities}
      className={className}
    />
  );
}
