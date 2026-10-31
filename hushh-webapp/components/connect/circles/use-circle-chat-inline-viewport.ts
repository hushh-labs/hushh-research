"use client";

import { useLayoutEffect, useRef } from "react";

export function useCircleChatInlineViewport(enabled: boolean) {
  const surface = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || !enabled) return;
    // CSS consumes the keyboard inset; only measure this card's starting edge.
    const measure = () => element.style.setProperty("--circle-chat-top", `${Math.max(0, element.getBoundingClientRect().top)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [enabled]);
  return surface;
}
