"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  AppStreamPanel,
  type AppStreamProgressItem,
} from "@/components/app-ui/stream-progress-panel";
import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import type {
  AgentStructuredExperience,
  AgentStructuredExperienceWithPresentation,
} from "@/lib/agent/agui-structured-experiences";
import {
  driveBatchProgressPercent,
  type DriveBatchProgress,
  type DriveCompilationUiState,
} from "@/lib/agent/drive-batch-progress";
import { driveOwnerCompileKey, type DriveOwnerCompileWindow } from "@/lib/agent/connector-read-receipt";
import type { AgentChatToolEvent, AgentSource } from "@/lib/services/agent-chat-client";

export type AgentVisibleStreamStatus = "running" | "done" | "blocked" | "error";

export type AgentVisibleStreamEvent = {
  id: string;
  label: string;
  message: string;
  status: AgentVisibleStreamStatus;
  createdAtMs: number;
  durationMs?: number;
  batchProgress?: DriveBatchProgress;
};

export const PRIVATE_MEMORY_PREPARATION_EVENT_ID = "private-memory-preparation";

export type AgentTurnStreamPanelProps = {
  streamEvents: AgentVisibleStreamEvent[];
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
  onOpenConnections?: (trigger: HTMLButtonElement) => void;
  onCompileDriveNotes?: (query: string, window: DriveOwnerCompileWindow) => void;
  onDownloadDriveNotes?: () => void;
  driveCompilation?: DriveCompilationUiState;
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

function unreadableNote(count: number): string {
  return count > 0
    ? ` ${count} ${count === 1 ? "file" : "files"} could not be read or processed.`
    : "";
}

export function driveBatchProgressToVisibleStreamEvent(
  progress: DriveBatchProgress,
  eventId?: string,
  nowMs = Date.now(),
): AgentVisibleStreamEvent {
  const message = (() => {
    switch (progress.phase) {
      case "searching":
        return "Finding matching Drive files.";
      case "fetching":
        return progress.total === 0
          ? "Reading matching Drive files."
          : `Checked ${progress.completed} of ${progress.total} files.${unreadableNote(progress.failed)}`;
      case "summarizing":
        return `Summarized ${progress.completed} of ${progress.total} readable files.${unreadableNote(progress.failed)}`;
      case "finalizing":
        return "Putting the checked notes into a Markdown file.";
      case "complete":
        return `Document batch complete.${unreadableNote(progress.failed)}`;
      case "partial":
        return `Document batch finished with some files unavailable.${unreadableNote(progress.failed)}`;
      case "error":
        return `Document batch stopped before completion.${unreadableNote(progress.failed)}`;
    }
  })();
  return {
    id: `drive-batch-progress:${eventId || "current"}`,
    label: "Google Drive",
    message,
    status: progress.phase === "error"
      ? "error"
      : progress.phase === "partial"
        ? "blocked"
        : progress.phase === "complete"
          ? "done"
          : "running",
    createdAtMs: nowMs,
    batchProgress: progress,
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
  sources = [],
  structuredExperience = null,
  structuredExperiences = [],
  onOpenConnections,
  onCompileDriveNotes,
  onDownloadDriveNotes,
  driveCompilation,
}: AgentTurnStreamPanelProps) {
  const turnStartedAt = useRef<number | null>(null);
  const [firstTextMs, setFirstTextMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [timingPhase, setTimingPhase] = useState<"idle" | "running" | "done">("idle");
  useEffect(() => {
    if (isStreaming && timingPhase !== "running") {
      turnStartedAt.current = performance.now();
      setFirstTextMs(null);
      setElapsedMs(0);
      setTimingPhase("running");
    } else if (!isStreaming && timingPhase === "running") {
      if (turnStartedAt.current !== null)
        setElapsedMs(Math.max(0, performance.now() - turnStartedAt.current));
      setTimingPhase("done");
    }
    if (!isStreaming) return;
    const timer = window.setInterval(() => {
      if (turnStartedAt.current !== null)
        setElapsedMs(Math.max(0, performance.now() - turnStartedAt.current));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming, timingPhase]);
  useEffect(() => {
    if (firstTextMs === null && responseText.trim() && turnStartedAt.current !== null)
      setFirstTextMs(Math.max(0, performance.now() - turnStartedAt.current));
  }, [firstTextMs, responseText]);
  const progressItems = useMemo<AppStreamProgressItem[]>(
    () =>
      streamEvents.map((event) => ({
        id: event.id,
        label: event.label,
        message: event.message,
        status: event.status,
        durationMs: event.durationMs,
      })),
    [streamEvents]
  );
  const specialistItems = useMemo(() => normalizeSpecialistSources(sources), [sources]);
  const currentBatchProgress = [...streamEvents].reverse().find((event) =>
    event.status === "running" && event.batchProgress,
  )?.batchProgress;
  // The owner starts a compilation from a completed chat turn. Keep its meter
  // active while the separate authenticated Drive stream is running.
  const batchIsStreaming = isStreaming || driveCompilation?.status === "running";
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
      progressValue={batchIsStreaming && currentBatchProgress
        ? driveBatchProgressPercent(currentBatchProgress)
        : null}
      progressIndeterminate={Boolean(
        batchIsStreaming && currentBatchProgress &&
        (currentBatchProgress.phase === "searching" ||
          (currentBatchProgress.phase === "fetching" && currentBatchProgress.total === 0) ||
          currentBatchProgress.phase === "summarizing" ||
          currentBatchProgress.phase === "finalizing"),
      )}
      statusMessage={elapsedMs === null || (isStreaming ? timingPhase !== "running" : timingPhase !== "done") ? undefined : isStreaming
        ? `Working for ${Math.floor(elapsedMs / 1000)}s`
        : `${isError ? "Stopped" : "Response complete"} in ${(elapsedMs / 1000).toFixed(1)}s${firstTextMs === null ? "" : ` · first text in ${(firstTextMs / 1000).toFixed(1)}s`}`}
      responseText={responseText}
      response={response}
      structuredContent={
        experienceItems.length > 0 ? (
          <div className="space-y-3">
            {experienceItems.map(({ id, experience }) => {
              const scopedCompilation = experience.type === "one.connector_read.v1" &&
                experience.connector === "drive" && experience.ownerCompileQuery &&
                experience.ownerCompileWindow && driveCompilation?.sourceKey ===
                  driveOwnerCompileKey(experience.ownerCompileQuery, experience.ownerCompileWindow)
                ? driveCompilation : undefined;
              return <AgentStructuredExperienceView
                key={id}
                experience={experience}
                onOpenConnections={onOpenConnections}
                onCompileDriveNotes={onCompileDriveNotes}
                onDownloadDriveNotes={scopedCompilation ? onDownloadDriveNotes : undefined}
                driveCompilation={scopedCompilation}
              />;
            })}
          </div>
        ) : null
      }
      responsePendingLabel={
        preparingPrivateMemory || currentBatchProgress
          ? undefined
          : "One is preparing your response."
      }
      isStreaming={isStreaming}
      isError={isError}
      opportunities={opportunities}
      className={className}
    />
  );
}
