"use client";

import { useCallback, useSyncExternalStore } from "react";

export type TopShellTabSwipeState = Readonly<{
  position: number;
  isDragging: boolean;
}>;

const DEFAULT_STATE: TopShellTabSwipeState = Object.freeze({
  position: 0,
  isDragging: false,
});

const states = new Map<string, TopShellTabSwipeState>();
const listeners = new Map<string, Set<() => void>>();

function normalizePosition(position: number): number {
  return Number.isFinite(position) ? Math.max(0, position) : 0;
}

export function setTopShellTabSwipeState(
  tabSetId: string,
  position: number,
  isDragging: boolean,
): void {
  const next: TopShellTabSwipeState = {
    position: normalizePosition(position),
    isDragging,
  };
  const current = states.get(tabSetId);
  if (
    current &&
    Math.abs(current.position - next.position) < 0.001 &&
    current.isDragging === next.isDragging
  ) {
    return;
  }
  states.set(tabSetId, next);
  listeners.get(tabSetId)?.forEach((listener) => listener());
}

function subscribe(tabSetId: string, listener: () => void): () => void {
  const tabListeners = listeners.get(tabSetId) ?? new Set<() => void>();
  tabListeners.add(listener);
  listeners.set(tabSetId, tabListeners);
  return () => {
    tabListeners.delete(listener);
    if (tabListeners.size === 0) {
      listeners.delete(tabSetId);
    }
  };
}

function readState(tabSetId: string): TopShellTabSwipeState {
  return states.get(tabSetId) ?? DEFAULT_STATE;
}

/** Shared visual state between a controlled workspace pager and its top tabs. */
export function useTopShellTabSwipeState(tabSetId: string): TopShellTabSwipeState {
  const subscribeToTab = useCallback(
    (listener: () => void) => subscribe(tabSetId, listener),
    [tabSetId],
  );
  const getSnapshot = useCallback(() => readState(tabSetId), [tabSetId]);
  return useSyncExternalStore(subscribeToTab, getSnapshot, getSnapshot);
}
