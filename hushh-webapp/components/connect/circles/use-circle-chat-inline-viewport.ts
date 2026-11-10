"use client";

import { useLayoutEffect, useRef } from "react";

export function useCircleChatInlineViewport(enabled: boolean) {
  const surface = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || !enabled) return;
    // CSS consumes the keyboard inset; only measure this card's starting edge.
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = `${Math.max(0, element.getBoundingClientRect().top)}px`;
      if (element.style.getPropertyValue("--circle-chat-top") !== top) element.style.setProperty("--circle-chat-top", top);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    const scrollRoot = element.closest("[data-app-scroll-root]");
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    scrollRoot?.addEventListener("scroll", schedule, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      scrollRoot?.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return surface;
}
