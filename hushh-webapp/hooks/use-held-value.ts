"use client";

import * as React from "react";

/**
 * useHeldValue
 *
 * Returns `value` while it is non-null, and keeps returning the last non-null
 * value for `holdMs` after `value` becomes null. A new non-null value always
 * wins immediately and cancels the pending release.
 *
 * It is the mirror of `useDebouncedValue`: that hook delays every change, this
 * one delays only the fall to "nothing", so a state that appears instantly can
 * bridge a short gap before it is allowed to disappear.
 *
 * Common use: a status that is genuinely continuous but is reported as a chain
 * of back-to-back jobs (one finishes, the next is queued a moment later). Held
 * across the hand-off, the status reads as one steady state instead of
 * flickering off and on at every seam.
 *
 * Semantics:
 *   - The first render returns `value` as-is (no waiting).
 *   - Cleans up the pending timeout on unmount.
 *   - Negative or non-finite `holdMs` is clamped to 0.
 *
 * @param value   The current value, or null when there is nothing to show.
 * @param holdMs  How long to keep the last non-null value after it ends.
 */
export function useHeldValue<T>(value: T | null, holdMs: number): T | null {
  const [held, setHeld] = React.useState<T | null>(value);

  React.useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    const clampedHold =
      typeof holdMs === "number" && Number.isFinite(holdMs) && holdMs > 0
        ? holdMs
        : 0;
    const timer = setTimeout(() => setHeld(null), clampedHold);
    return () => clearTimeout(timer);
  }, [value, holdMs]);

  return value ?? held;
}
