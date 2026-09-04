"use client";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { PendingOneSystemActionInvocation } from "@/lib/capacitor/one-system-action-invocation";

export type OneSystemActionExecutor = (
  invocation: PendingOneSystemActionInvocation,
) => Promise<AgentActionRuntimeResult>;

let activeExecutor: OneSystemActionExecutor | null = null;
let revision = 0;
const subscribers = new Set<() => void>();

export function registerOneSystemActionExecutor(
  executor: OneSystemActionExecutor,
): () => void {
  activeExecutor = executor;
  revision += 1;
  subscribers.forEach((subscriber) => subscriber());
  return () => {
    if (activeExecutor !== executor) return;
    activeExecutor = null;
    revision += 1;
    subscribers.forEach((subscriber) => subscriber());
  };
}

export function isOneSystemActionExecutorReady(): boolean {
  return activeExecutor !== null;
}

export function oneSystemActionExecutorRevision(): number {
  return revision;
}

export function subscribeOneSystemActionExecutor(
  subscriber: () => void,
): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export async function executeOneSystemActionInvocation(
  invocation: PendingOneSystemActionInvocation,
): Promise<AgentActionRuntimeResult> {
  const executor = activeExecutor;
  if (!executor) {
    return {
      status: "blocked",
      actionId: invocation.actionId,
      label: null,
      routeBefore: null,
      resultSummary: "HUSSH is still preparing the action runtime.",
      reason: "system_action_executor_not_ready",
    };
  }
  return executor(invocation);
}
