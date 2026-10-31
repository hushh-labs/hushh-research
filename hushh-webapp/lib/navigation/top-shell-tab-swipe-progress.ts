"use client";

import { useCallback, useSyncExternalStore } from "react";

export type TopShellTabSwipeState = Readonly<{
  position: number;
  /**
   * True while the pager is the authority for `position` -- a finger is on it,
   * OR it is mid-flight to a tab the person just tapped.
   *
   * It used to mean "a finger is on it" alone, and that is what made a tap look
   * mechanical. The strip wrote the destination index once and eased it with a
   * 240ms CSS transition; the pager then overwrote the same variable with live
   * scroll progress on every frame of that same transition, retargeting it each
   * frame. Measured on a 390px viewport: the panel finished moving at ~400ms
   * while the pill was still creeping at ~600ms. With Reduce Motion on -- where
   * the strip's transition is off -- the pill jumped straight to the
   * destination and then snapped backwards, because the pager's first progress
   * frame landed after it (indicator x: 16 -> 135 -> 29 -> ... -> 135).
   *
   * One writer at a time is the fix. While this is true the pager owns the
   * variable outright and the strip neither writes it nor transitions it, so
   * the pill IS the panel's position rather than a second animation of it.
   */
  pagerOwned: boolean;
}>;

const DEFAULT_STATE: TopShellTabSwipeState = Object.freeze({
  position: 0,
  pagerOwned: false,
});

const states = new Map<string, TopShellTabSwipeState>();
const listeners = new Map<string, Set<() => void>>();
const pagers = new Map<string, number>();
const TOP_SHELL_TAB_SELECTION_EVENT = "hushh:top-shell-tab-selection";

function positionVariable(tabSetId: string): string {
  return `--top-shell-tab-swipe-${tabSetId.replace(/[^a-zA-Z0-9_-]/g, "-")}-position`;
}

/** CSS variable used by the compositor-owned tab underline while a pager owns it. */
export function topShellTabSwipePositionVariable(tabSetId: string): string {
  return positionVariable(tabSetId);
}

function normalizePosition(position: number): number {
  return Number.isFinite(position) ? Math.max(0, position) : 0;
}

export function setTopShellTabSwipeState(
  tabSetId: string,
  position: number,
  pagerOwned: boolean,
): void {
  const next: TopShellTabSwipeState = {
    position: normalizePosition(position),
    pagerOwned,
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

  // Pager frames update a CSS property, not the React tree. Consumers only
  // rerender when ownership changes hands, so they can toggle transition
  // policy once per gesture instead of once per frame.
  if (current && current.pagerOwned === next.pagerOwned) {
    states.set(tabSetId, next);
    return;
  }
  if (
    current &&
    Math.abs(current.position - next.position) < 0.001 &&
    current.pagerOwned === next.pagerOwned
  ) {
    return;
  }
  states.set(tabSetId, next);
  listeners.get(tabSetId)?.forEach((listener) => listener());
}

/**
 * Declares that a pager is mounted for this tab set and will drive the shared
 * position variable itself.
 *
 * The strip asks this before doing its own optimistic write on a tap. Where a
 * pager exists, that write is not merely redundant -- it is the first half of
 * the two-writer race described on `pagerOwned` above. Where no pager exists
 * (the route-backed RIA workspace, whose tabs are separate screens), the strip
 * stays the only writer and keeps its own 240ms transition.
 *
 * Counted rather than flagged: React can mount the next instance before
 * unmounting the previous one during a route change, and a plain boolean would
 * be cleared by the outgoing unmount.
 */
export function registerTopShellTabPager(tabSetId: string): () => void {
  pagers.set(tabSetId, (pagers.get(tabSetId) ?? 0) + 1);
  return () => {
    const remaining = (pagers.get(tabSetId) ?? 0) - 1;
    if (remaining > 0) {
      pagers.set(tabSetId, remaining);
      return;
    }
    pagers.delete(tabSetId);
  };
}

export function hasTopShellTabPager(tabSetId: string): boolean {
  return (pagers.get(tabSetId) ?? 0) > 0;
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
