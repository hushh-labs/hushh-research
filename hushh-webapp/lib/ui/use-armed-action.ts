"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A confirming second tap for an irreversible button (Deny, Decline, Cancel,
 * Stop sharing).
 *
 * The first activation arms the button, which then reads "Sure?"; a second
 * activation inside the window disarms it and runs the action. If the second
 * tap never comes, the button disarms itself after `disarmAfterMs`, so a stray
 * tap cannot reject a request or abort running work. Unmounting clears the
 * timer.
 *
 * Extracted verbatim from the feed's actionable row so the Consent Center can
 * confirm the same way, from one implementation.
 */

export const ARMED_ACTION_CONFIRM_LABEL = "Sure?";
export const ARMED_ACTION_DEFAULT_DISARM_MS = 3500;

export type UseArmedActionOptions = {
  /** How long an armed button waits for the confirming tap. */
  disarmAfterMs?: number;
};

export type ArmedAction = {
  /** True between the arming tap and either the confirming tap or the timeout. */
  armed: boolean;
  /** First call arms; a call while armed disarms and runs `fire`. */
  activate: (fire: () => void) => void;
  /** Drop the armed state without firing, e.g. when a sibling action locks the row. */
  disarm: () => void;
  /** "Sure?" while armed, otherwise the resting label. */
  label: (restingLabel: string) => string;
  /** Accessible name: "Confirm X" while armed, "X (tap again to confirm)" at rest. */
  ariaLabel: (restingLabel: string) => string;
};

export function useArmedAction({
  disarmAfterMs = ARMED_ACTION_DEFAULT_DISARM_MS,
}: UseArmedActionOptions = {}): ArmedAction {
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDisarmTimer = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
  }, []);

  useEffect(() => clearDisarmTimer, [clearDisarmTimer]);

  const disarm = useCallback(() => {
    setArmed(false);
    clearDisarmTimer();
  }, [clearDisarmTimer]);

  const activate = useCallback(
    (fire: () => void) => {
      if (!armed) {
        setArmed(true);
        clearDisarmTimer();
        disarmTimer.current = setTimeout(() => setArmed(false), disarmAfterMs);
        return;
      }
      disarm();
      fire();
    },
    [armed, clearDisarmTimer, disarm, disarmAfterMs],
  );

  const label = useCallback(
    (restingLabel: string) =>
      armed ? ARMED_ACTION_CONFIRM_LABEL : restingLabel,
    [armed],
  );

  const ariaLabel = useCallback(
    (restingLabel: string) =>
      armed
        ? `Confirm ${restingLabel}`
        : `${restingLabel} (tap again to confirm)`,
    [armed],
  );

  return { armed, activate, disarm, label, ariaLabel };
}
