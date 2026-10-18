"use client";

import { useCallback, useEffect, useRef, type AnimationEvent, type FocusEvent, type PointerEvent, type MouseEvent } from "react";
import { prefersReducedMotion } from "../gsap";

const PLAYING_ATTRIBUTE = "data-shortcut-icon-playing";

/** Latch a finite SVG-part cycle without rerendering the row or its label. */
export function useShortcutIconMotion() {
  const activeRows = useRef(new Map<HTMLButtonElement, () => void>());

  const finish = useCallback((row: HTMLButtonElement) => {
    const removeListener = activeRows.current.get(row);
    activeRows.current.delete(row);
    removeListener?.();
    row.removeAttribute(PLAYING_ATTRIBUTE);
  }, []);

  useEffect(() => {
    const rows = activeRows.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reset = () => {
      if (reducedMotion.matches) rows.forEach((_listener, row) => finish(row));
    };
    const visibility = () => {
      if (document.hidden) rows.forEach((_listener, row) => finish(row));
    };
    reducedMotion.addEventListener("change", reset);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      reducedMotion.removeEventListener("change", reset);
      document.removeEventListener("visibilitychange", visibility);
      rows.forEach((_listener, row) => finish(row));
    };
  }, [finish]);

  const start = useCallback((row: HTMLButtonElement) => {
    // A fresh entry during playback does not interrupt the current sequence.
    if (row.disabled || activeRows.current.has(row) || prefersReducedMotion() || document.hidden) return;
    activeRows.current.forEach((_listener, activeRow) => {
      if (!activeRow.isConnected) finish(activeRow);
    });
    const onCancel = (event: globalThis.AnimationEvent) => {
      if (event.target instanceof Element && event.target.hasAttribute("data-shortcut-icon-cycle")) finish(row);
    };
    row.addEventListener("animationcancel", onCancel);
    activeRows.current.set(row, () => row.removeEventListener("animationcancel", onCancel));
    row.setAttribute(PLAYING_ATTRIBUTE, "true");
  }, [finish]);

  return {
    onClickCapture: useCallback((event: MouseEvent<HTMLButtonElement>) => {
      start(event.currentTarget);
    }, [start]),
    onPointerEnter: useCallback((event: PointerEvent<HTMLButtonElement>) => {
      // A real mouse/pen entry is sufficient. Embedded browsers can report no
      // hover capability even when they deliver pointer hover events.
      if (event.pointerType !== "touch") start(event.currentTarget);
    }, [start]),
    onFocus: useCallback((event: FocusEvent<HTMLButtonElement>) => {
      if (event.currentTarget.matches(":focus-visible")) start(event.currentTarget);
    }, [start]),
    onAnimationEnd: useCallback((event: AnimationEvent<HTMLButtonElement>) => {
      // Ripples and the circle background do not own the paper/arrow/plug cycle.
      if (event.target instanceof Element && event.target.hasAttribute("data-shortcut-icon-cycle")) finish(event.currentTarget);
    }, [finish]),
  };
}
