"use client";

/**
 * Don't allow, with a short Undo window.
 *
 * A decline is decided on the row itself, with one tap and no confirming
 * second tap. What makes one tap safe is that nothing is sent yet: the row
 * leaves at once, an Undo toast stays up for five seconds, and the real deny
 * call goes out only when that window closes. Undo puts the row back and sends
 * nothing.
 *
 * A decision is never silently lost. Leaving the screen before the window
 * closes sends the deny at once (the hook flushes on unmount and on `pagehide`)
 * rather than dropping it. If the browser tears the page down before that
 * request lands, the request simply stays waiting: a lost decline can only ever
 * leave information unshared, never share it.
 *
 * Every surface that declines inline (the Consent Center row, the Feed row)
 * goes through this one helper, so the window, the copy and the flush rule are
 * the same wherever the person taps.
 */

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

/** How long the Undo toast holds a decline before it is sent. */
export const CONSENT_DECLINE_UNDO_MS = 5000;

export interface DeferredConsentDecline {
  key: string;
  /** Send now instead of waiting. Does nothing once sent or undone. */
  flush: () => void;
  /** Undo: nothing is sent. Does nothing once sent or undone. */
  undo: () => void;
}

export interface ScheduleConsentDeclineOptions {
  /** One decline per request; also the toast id. */
  key: string;
  /** The toast line, e.g. "Declined Kushal's request." */
  message: string;
  /** The real deny call. Runs exactly once, or never after Undo. */
  send: () => void | Promise<unknown>;
  /** Undo was tapped: put the row back. */
  onUndo: () => void;
  /** Called once the decline leaves the window, either way. */
  onSettled?: () => void;
  delayMs?: number;
}

export function scheduleConsentDecline(
  options: ScheduleConsentDeclineOptions,
): DeferredConsentDecline {
  const toastId = `consent-decline:${options.key}`;
  let state: "waiting" | "sent" | "undone" = "waiting";

  const close = () => {
    clearTimeout(timer);
    toast.dismiss(toastId);
    options.onSettled?.();
  };
  const flush = () => {
    if (state !== "waiting") return;
    state = "sent";
    close();
    void options.send();
  };
  const undo = () => {
    if (state !== "waiting") return;
    state = "undone";
    close();
    options.onUndo();
  };

  const delayMs = options.delayMs ?? CONSENT_DECLINE_UNDO_MS;
  // The timer, not the toast, owns the deadline: a toast pauses while it is
  // hovered, and a decision must not wait on where the pointer rests.
  const timer = setTimeout(flush, delayMs);
  toast(options.message, {
    id: toastId,
    duration: delayMs,
    action: { label: "Undo", onClick: undo },
  });
  return { key: options.key, flush, undo };
}

/**
 * Declines scheduled from one mounted surface. Unmounting the surface, or the
 * page going away, sends every decline still waiting (see the module note).
 */
export function useDeferredConsentDeclines() {
  const waitingRef = useRef(new Map<string, DeferredConsentDecline>());

  const schedule = useCallback(
    (options: ScheduleConsentDeclineOptions): DeferredConsentDecline => {
      const existing = waitingRef.current.get(options.key);
      // A second tap on the same request while its window is open is the same
      // decision, not a second one.
      if (existing) return existing;
      const decline = scheduleConsentDecline({
        ...options,
        onSettled: () => {
          waitingRef.current.delete(options.key);
          options.onSettled?.();
        },
      });
      waitingRef.current.set(options.key, decline);
      return decline;
    },
    [],
  );

  const flushAll = useCallback(() => {
    for (const decline of [...waitingRef.current.values()]) decline.flush();
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [flushAll]);

  return { schedule, flushAll };
}
