"use client";

import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

/** A stationary touch opens its message actions; taps and scrolling do not. */
export function useLongPress(disabled = false, allowCurrentTargetButton = false, delayMs = 1_000) {
  const activated = useRef(false);
  const resetClick = useCallback(() => { activated.current = false; }, []);
  const consumeClick = useCallback((event: MouseEvent<HTMLElement>) => {
    // A touch release can land on the newly opened portal. A fresh contact
    // clears this flag before its click; keyboard activation remains available.
    if (!activated.current || event.detail === 0) return;
    activated.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);

  const cancel = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);

  useEffect(() => {
    if (disabled) cancel();
    return cancel;
  }, [disabled, cancel]);

  const start = useCallback((event: PointerEvent<HTMLElement>, onPress: () => void) => {
    cancel();
    resetClick();
    if (disabled || event.pointerType === "mouse" || event.button > 0 || event.isPrimary === false) return;
    const interactive = (event.target as HTMLElement).closest("button, a, input, textarea, select, [role=menuitem], [contenteditable=true]");
    if (interactive && !(allowCurrentTargetButton && interactive === event.currentTarget && interactive.tagName === "BUTTON")) return;
    pending.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        pending.current = null;
        activated.current = true;
        onPress();
        window.navigator.vibrate?.(8);
      }, delayMs),
    };
  }, [cancel, disabled, allowCurrentTargetButton, delayMs, resetClick]);

  const move = useCallback((event: PointerEvent<HTMLElement>) => {
    const origin = pending.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel();
  }, [cancel]);

  return { start, move, cancel, resetClick, consumeClick };
}
