/**
 * In-process tap on governed analytics events after schema sanitization. It
 * carries only the sanitized payload that is already allowed to leave the
 * device, and it is isolated from delivery: a listener receives a frozen copy,
 * runs inside its own try/catch and can never change or block analytics.
 */

export type TrackedEventListener = (eventName: string, sanitized: Readonly<Record<string, unknown>>) => void;

const listeners = new Set<TrackedEventListener>();

export function subscribeTrackedEvents(listener: TrackedEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by lib/observability/client.ts trackEvent right after validateAndSanitizeEvent succeeds (non-fatal). Each listener is isolated in try/catch; a listener can never affect analytics. */
export function publishTrackedEvent(eventName: string, sanitized: Readonly<Record<string, unknown>>): void {
  if (!listeners.size) return;
  const snapshot = Object.freeze({ ...sanitized });
  for (const listener of [...listeners]) {
    try {
      listener(eventName, snapshot);
    } catch {
      // A local consumer's failure must never reach the analytics caller.
    }
  }
}
