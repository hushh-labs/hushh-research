"use client";

import { useMemo } from "react";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { useCalendarUpcomingEvents, type RedactedCalendarEvent } from "@/lib/calendar/use-calendar-upcoming-events";
import { useFeedActionables, type FeedActionable } from "@/lib/feed/use-feed-actionables";
import { useFeedBriefing, type FeedKycBriefing } from "@/lib/feed/use-feed-briefing";
import { agentTodoInput, buildTodo, calendarTodoInput, isLiveAgentTodo, openTodoItems, type TodoItem } from "@/lib/services/todo-list-pkm-service";
import { taskSort } from "@/lib/todos/todo-list-model";
import { useTodoCapabilitySources } from "./use-todo-capability-sources";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import type { TaskCapability, TaskCoverage, TaskEvidence } from "./task-suggestion-model";

const sourceCapabilities: Partial<Record<NonNullable<TodoItem["sourceAgent"]>, TaskCapability>> = {
  calendar: "calendar", gmail: "gmail", kai: "finance", location: "location",
  consent: "consent", connections: "consent", drive: "consent", kyc: "gmail",
  messages: "messages", wallet: "wallet", ria: "ria", pkm: "pkm",
};

function calendarStart(event: RedactedCalendarEvent): Date | null {
  const value =
    event.start?.dateTime ??
    (event.start?.date ? `${event.start.date}T00:00:00` : null);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function calendarTask(
  event: RedactedCalendarEvent,
  index: number,
): TodoItem | null {
  const start = calendarStart(event);
  if (!start || event.status?.toLowerCase() === "cancelled") return null;
  const sourceId = event.id ?? `${event.title}-${start.toISOString()}-${index}`;
  const input = calendarTodoInput({
    id: sourceId,
    title: event.title,
    start: event.start,
    conferenceUrl: event.conferenceUrl,
  });
  return input ? buildTodo(input, start.toISOString()) : null;
}

/** Merge fresh Calendar projection with encrypted owner completion/dismissal state. */
function mergeAutomaticTasks(
  events: RedactedCalendarEvent[],
  saved: TodoItem[],
): TodoItem[] {
  const savedAutomatic = new Map(
    saved
      .filter((task) => task.type === "automatic" && !isLiveAgentTodo(task))
      .map((task) => [task.sourceId ?? task.id, task]),
  );
  const seen = new Set<string>();
  const projected = events.flatMap((event, index) => {
    const fromCalendar = calendarTask(event, index);
    if (!fromCalendar) return [];
    const key = fromCalendar.sourceId ?? fromCalendar.id;
    seen.add(key);
    const stored = savedAutomatic.get(key);
    if (stored?.status === "done" || stored?.status === "deleted") return [];
    return [
      {
        ...fromCalendar,
        ...(stored
          ? {
              status: stored.status,
              completedAt: stored.completedAt,
              deletedAt: stored.deletedAt,
              createdAt: stored.createdAt,
              updatedAt: stored.updatedAt,
            }
          : {}),
      },
    ];
  });

  // The Calendar read may lag briefly after a successful booking. Keep the
  // encrypted automatic snapshot visible until the provider projection catches up.
  for (const task of savedAutomatic.values()) {
    const key = task.sourceId ?? task.id;
    if (task.status === "pending" && !seen.has(key)) projected.push(task);
  }
  return projected.sort(taskSort);
}

function projectTodoTasks(
  tasks: TodoItem[],
  events: RedactedCalendarEvent[],
  actionables: Pick<FeedActionable, "id" | "todo">[],
  pendingKyc: Pick<FeedKycBriefing, "count" | "workflowId"> | null,
  extra: TaskEvidence[],
): TodoItem[] {
    const saved = new Map(tasks.map((task) => [task.id, task]));
    const live = new Map<string, TodoItem>();
    for (const item of actionables) {
      if (!item.todo) continue;
      const input = agentTodoInput(item.id, item.todo);
      if (!input) continue;
      const task = buildTodo(input);
      const status = saved.get(task.id)?.status;
      if (status !== "done" && status !== "deleted") live.set(task.id, task);
    }
    for (const item of extra) {
      if (!item.pendingTitle) continue;
      const input = agentTodoInput(item.key, { source: item.capability === "finance" ? "kai" : item.capability, title: item.pendingTitle, href: item.href });
      if (!input) continue;
      const task = buildTodo(input);
      const status = saved.get(task.id)?.status;
      if (status !== "done" && status !== "deleted") live.set(task.id, task);
    }
    if (pendingKyc) {
      const input = agentTodoInput(`kyc:${pendingKyc.workflowId}`, {
        source: "kyc",
        title:
          pendingKyc.count > 1
            ? `Review ${pendingKyc.count} information requests`
            : "Review information request",
        href: "/one/gmail?workspace=kyc",
      });
      if (input) {
        const task = buildTodo(input);
        const status = saved.get(task.id)?.status;
        if (status !== "done" && status !== "deleted") live.set(task.id, task);
      }
    }
    return [
      ...mergeAutomaticTasks(events, tasks),
      ...live.values(),
      ...openTodoItems(tasks).filter((task) => task.type === "manual"),
    ].sort(taskSort);
}

/** Live task projection shared by the page and One profile tab.
 * Only explicit source todos are included; projecting tasks never writes PKM
 * or executes a task's source action. The existing feed hook retains its own
 * refresh and previously requested clear lifecycle. Completion stays in PKM. */
export function useTodoLiveTasks({ userId, vaultOwnerToken, idTokenProvider, enabled, tasks }: {
  userId: string | null;
  vaultOwnerToken: string | null;
  idTokenProvider: (() => Promise<string>) | null;
  enabled: boolean;
  tasks: TodoItem[];
}) {
  const agentFeed = useFeedActionables({ enabled, allPending: true });
  const { pendingKyc, kycLoading, kycError, retryKyc } = useFeedBriefing({ enabled, includeCalendar: false, includeNudges: false });
  const calendar = useCalendarConnectionStatus({ userId: enabled ? userId : null, idTokenProvider: enabled ? idTokenProvider : null });
  const upcoming = useCalendarUpcomingEvents({ userId: enabled ? userId : null, vaultOwnerToken: enabled ? vaultOwnerToken : null, isConnected: enabled && calendar.connected, windowHours: 168 });
  const gmail = useGmailConnectorStatus({ userId: enabled ? userId : null, idTokenProvider: enabled ? idTokenProvider : null });
  const extra = useTodoCapabilitySources({ enabled, userId, vaultOwnerToken, idTokenProvider, mailConnected: gmail.status?.connected === true && gmail.status.needs_reauth !== true, calendarConnected: calendar.connected, mailStatusKnown: Boolean(gmail.status) && !gmail.statusError, calendarStatusKnown: calendar.loaded && !calendar.error });
  const evidence = useMemo(() => extra.reads.flatMap(read => read.evidence), [extra.reads]);
  const agentLoadError = agentFeed.error || agentFeed.progressError || kycError;
  const agentLoading = agentFeed.loading || agentFeed.progressLoading || kycLoading;
  const calendarReadLoading = enabled && (!calendar.loaded || calendar.loading || (calendar.connected && (!upcoming.loaded || upcoming.loading)));
  const calendarReadError = Boolean(calendar.error || upcoming.error);
  const pending = useMemo(
    () => projectTodoTasks(tasks, upcoming.events, agentFeed.actionables, pendingKyc, evidence),
    [tasks, upcoming.events, agentFeed.actionables, pendingKyc, evidence],
  );
  const coverage: TaskCoverage[] = ["finance", "location", "consent"].map(capability => ({ capability: capability as TaskCapability, count: pending.filter(task => task.sourceAgent && sourceCapabilities[task.sourceAgent] === capability).length, status: agentLoadError ? "unavailable" : capability === "consent" && agentFeed.inventoryIncomplete ? "incomplete" : "ready" }));
  const allCoverage = [...coverage, ...extra.reads.map(read => read.coverage.capability === "calendar" ? { ...read.coverage, count: pending.filter(task => task.sourceAgent === "calendar").length, status: calendarReadError ? "unavailable" as const : read.coverage.status } : read.coverage)];
  const suggestionEvidence: TaskEvidence[] = [...evidence];
  for (const task of pending) {
    const capability = task.sourceAgent && sourceCapabilities[task.sourceAgent];
    const key = task.sourceId?.startsWith("feed:") ? task.sourceId.slice(5) : task.id;
    if (capability && !suggestionEvidence.some(item => item.key === key)) suggestionEvidence.push({
      capability, key, summary: task.title, pendingTitle: task.title,
      href: task.link || "/one/todos",
    });
  }
  return {
    pending: enabled ? pending : [], agentFeed, retryKyc, calendar, upcoming,
    agentLoadError, agentLoading: enabled && agentLoading, calendarReadLoading, calendarReadError,
    evidence: suggestionEvidence, coverage: allCoverage, sourceLoading: extra.loading || agentLoading || calendarReadLoading,
    sourceError: extra.error || allCoverage.some(source => source.status === "unavailable" || source.status === "incomplete"), refreshSources: extra.refresh,
  };
}
