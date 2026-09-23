"use client";

import { useEffect } from "react";

const APP_SCROLL_ROOT_SELECTOR = "[data-app-scroll-root='true']";

export function getAppScrollRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(APP_SCROLL_ROOT_SELECTOR);
}

export function scrollAppToTop(behavior: ScrollBehavior = "auto"): void {
  const root = getAppScrollRoot();
  if (root) {
    if (typeof root.scrollTo === "function") {
      root.scrollTo({ top: 0, behavior });
    } else {
      root.scrollTop = 0;
    }
    return;
  }
  if (typeof window !== "undefined") {
    const isJsdom =
      typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
    if (isJsdom) {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      return;
    }
    try {
      if (typeof window.scrollTo === "function") {
        window.scrollTo({ top: 0, behavior });
      } else {
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    } catch {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
  }
}

export function useScrollReset(
  key: unknown,
  options: { enabled?: boolean; behavior?: ScrollBehavior } = {}
): void {
  const enabled = options.enabled ?? true;
  const behavior = options.behavior ?? "auto";

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let rafA = 0;

    const run = () => {
      if (cancelled) return;
      scrollAppToTop(behavior);
    };

    // Immediate reset, then one follow-up after the incoming route's first
    // layout. Each scrollTo forces a layout when the document is dirty, and
    // the previous four writes per navigation (immediate, frame, double
    // frame, 120 ms) landed exactly while the new page was laying out. The
    // follow-up writes only when something moved the scroll in between.
    run();
    rafA = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const root = getAppScrollRoot();
      const offset = root ? root.scrollTop : window.scrollY;
      if (offset !== 0) run();
    });

    return () => {
      cancelled = true;
      if (rafA) window.cancelAnimationFrame(rafA);
    };
  }, [enabled, behavior, key]);
}
