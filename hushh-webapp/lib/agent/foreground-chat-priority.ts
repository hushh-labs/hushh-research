"use client";

import { useSyncExternalStore } from "react";

// Metadata-only process state. It carries no owner, conversation, prompt, or
// credential; it only lets optional shell reads yield while Chat owns the
// foreground database budget.
let leaseCount = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function beginForegroundChatPriority(): () => void {
  leaseCount += 1;
  if (leaseCount === 1) publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    leaseCount = Math.max(0, leaseCount - 1);
    if (leaseCount === 0) publish();
  };
}

export function isForegroundChatActive(): boolean {
  return leaseCount > 0;
}

export function subscribeForegroundChatPriority(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useForegroundChatActive(): boolean {
  return useSyncExternalStore(
    subscribeForegroundChatPriority,
    isForegroundChatActive,
    () => false,
  );
}

/** Test seam; production callers release their own idempotent lease. */
export function resetForegroundChatPriorityForTests(): void {
  const changed = leaseCount !== 0;
  leaseCount = 0;
  if (changed) publish();
}
