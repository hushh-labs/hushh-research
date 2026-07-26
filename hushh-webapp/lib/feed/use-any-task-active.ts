"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  AppBackgroundTaskService,
  isAppBackgroundTaskVisible,
} from "@/lib/services/app-background-task-service";
import { DebateRunManagerService } from "@/lib/services/debate-run-manager";

export type TaskActiveState = {
  hasActiveTask: boolean;
  hasEmergencyAlert: boolean;
};

const IDLE_STATE: TaskActiveState = { hasActiveTask: false, hasEmergencyAlert: false };

function isEmergencySmsTask(task: { kind: string; metadata?: unknown }): boolean {
  const metadata =
    task.metadata && typeof task.metadata === "object"
      ? (task.metadata as Record<string, unknown>)
      : null;
  return (
    task.kind === "one_location_share" &&
    String(metadata?.shareKind || "").trim().toLowerCase() === "sos"
  );
}

/**
 * Status-only signal for the Feed tab's spinner overlay: is a debate or
 * background task currently running for this user. Extracted from
 * DebateTaskCenter's own filtering logic; task-level control (cancel, retry,
 * dismiss) stays on the pages that own those flows (Analysis, kai-flow), not
 * in the shell.
 */
export function useAnyTaskActive(): TaskActiveState {
  const { userId } = useAuth();
  const [debateState, setDebateState] = useState(DebateRunManagerService.getState());
  const [appTaskState, setAppTaskState] = useState(AppBackgroundTaskService.getState());

  useEffect(() => DebateRunManagerService.subscribe(setDebateState), []);
  useEffect(() => AppBackgroundTaskService.subscribe(setAppTaskState), []);

  if (!userId) return IDLE_STATE;

  const debateTasks = debateState.tasks.filter(
    (task) => task.userId === userId && !task.dismissedAt,
  );
  const visibleAppTasks = appTaskState.tasks.filter(
    (task) => task.userId === userId && !task.dismissedAt && isAppBackgroundTaskVisible(task),
  );

  const hasActiveTask =
    debateTasks.some((task) => task.status === "running") ||
    visibleAppTasks.some((task) => task.status === "running");
  const hasEmergencyAlert = visibleAppTasks.some(isEmergencySmsTask);

  return { hasActiveTask, hasEmergencyAlert };
}
