"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";

/**
 * Run `callback` on the shared idle clock every `intervalMs` while `enabled`
 * and the document is visible. The callback is read through a ref, so a new
 * closure each render never re-registers the task.
 */
export function usePeriodicTask(
  id: string,
  intervalMs: number,
  callback: () => void | Promise<void>,
  options: { enabled?: boolean; immediate?: boolean } = {},
): void {
  const { enabled = true, immediate = false } = options;
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;
    return registerPeriodicTask({
      id,
      intervalMs,
      immediate,
      run: () => callbackRef.current(),
    });
  }, [enabled, id, immediate, intervalMs]);
}

type ClockStore = {
  value: number;
  listeners: Set<() => void>;
  unregister: (() => void) | null;
};

const clocks = new Map<number, ClockStore>();

function clockFor(intervalMs: number): ClockStore {
  let store = clocks.get(intervalMs);
  if (!store) {
    store = { value: Date.now(), listeners: new Set(), unregister: null };
    clocks.set(intervalMs, store);
  }
  return store;
}

function subscribeClock(intervalMs: number, listener: () => void): () => void {
  const store = clockFor(intervalMs);
  store.listeners.add(listener);
  if (!store.unregister) {
    store.unregister = registerPeriodicTask({
      id: `coarse-clock:${intervalMs}`,
      intervalMs,
      run: () => {
        store.value = Date.now();
        for (const notify of store.listeners) notify();
      },
    });
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0 && store.unregister) {
      store.unregister();
      store.unregister = null;
    }
  };
}

/**
 * A "now" that advances every `intervalMs` on the shared idle clock, for
 * relative-time labels and staleness checks. Every consumer of the same
 * interval shares one timer and one wake, instead of each holding a
 * `setInterval(() => setNow(Date.now()))` of its own.
 */
export function useCoarseClock(intervalMs: number): number {
  return useSyncExternalStore(
    (listener) => subscribeClock(intervalMs, listener),
    () => clockFor(intervalMs).value,
    () => clockFor(intervalMs).value,
  );
}
