"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/** Public geometry of the canonical shell slot; never a second width policy. */
export type NativeNavigationColumn = { x: number; width: number; contentHeight: number; viewportWidth: number };

export function measureNativeNavigationColumn(slot: HTMLElement | null): NativeNavigationColumn | null {
  if (!slot) return null;
  const frame = slot.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  if (![frame.x, frame.width, frame.height, viewportWidth].every(Number.isFinite) ||
      viewportWidth <= 0 || frame.x < 0 || frame.width < 220 || frame.x + frame.width > viewportWidth + 0.5 ||
      frame.height < 49 || frame.height > 120) return null;
  return { x: frame.x, width: frame.width, contentHeight: frame.height, viewportWidth };
}

/** Resize boundaries only: never measure or repaint per scroll/audio frame. */
export function useNativeNavigationColumn(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const [column, setColumn] = useState<NativeNavigationColumn | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    const publish = () => {
      const next = measureNativeNavigationColumn(ref.current);
      setColumn(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    publish();
    const observer = new ResizeObserver(publish);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", publish);
    return () => { observer.disconnect(); window.removeEventListener("resize", publish); };
  }, [ref, enabled]);
  return enabled ? column : null;
}
