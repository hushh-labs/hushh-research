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
const TOP_SHELL_TAB_SELECTION_EVENT = "hushh:top-shell-tab-selection";

function positionVariable(tabSetId: string): string {
  return `--top-shell-tab-swipe-${tabSetId.replace(/[^a-zA-Z0-9_-]/g, "-")}-position`;
}

/** CSS variable used by the compositor-owned tab underline during a drag. */
export function topShellTabSwipePositionVariable(tabSetId: string): string {
  return positionVariable(tabSetId);
}

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
  if (typeof document !== "undefined") {
    const variable = positionVariable(tabSetId);
    const value = String(next.position);
    // Keep drag-frame style invalidation inside the tiny tab strip. Writing
    // this inherited variable on <html> forced the entire app (including
    // chart-heavy Finance panes) through style recalculation on every frame.
    const tabStrip = document.querySelector<HTMLElement>(
      `[data-top-shell-tab-set="${CSS.escape(tabSetId)}"]`,
    );
    const styleOwner = tabStrip ?? document.documentElement;
    if (styleOwner.style.getPropertyValue(variable) !== value) {
      styleOwner.style.setProperty(variable, value);
    }
  }

  // Drag frames update a CSS property, not the React tree. Consumers only
  // rerender at the start/end of a drag so they can toggle transition policy.
  if (current && current.isDragging === next.isDragging) {
    states.set(tabSetId, next);
    return;
  }
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

/** Requests an immediate visual pane selection before query navigation settles. */
export function requestTopShellTabSelection(
  tabSetId: string,
  value: string,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TOP_SHELL_TAB_SELECTION_EVENT, {
      detail: { tabSetId, value },
    }),
  );
}

export function subscribeTopShellTabSelection(
  listener: (selection: { tabSetId: string; value: string }) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      !detail ||
      typeof detail !== "object" ||
      !("tabSetId" in detail) ||
      !("value" in detail) ||
      typeof detail.tabSetId !== "string" ||
      typeof detail.value !== "string"
    ) {
      return;
    }
    listener({ tabSetId: detail.tabSetId, value: detail.value });
  };
  window.addEventListener(TOP_SHELL_TAB_SELECTION_EVENT, handle);
  return () => window.removeEventListener(TOP_SHELL_TAB_SELECTION_EVENT, handle);
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
export function useTopShellTabSwipeState(
  tabSetId: string,
): TopShellTabSwipeState {
  const subscribeToTab = useCallback(
    (listener: () => void) => subscribe(tabSetId, listener),
    [tabSetId],
  );
  const getSnapshot = useCallback(() => readState(tabSetId), [tabSetId]);
  return useSyncExternalStore(subscribeToTab, getSnapshot, getSnapshot);
}
