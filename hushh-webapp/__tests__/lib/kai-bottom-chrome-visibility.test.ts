import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  onScroll,
  resetKaiBottomChromeVisibility,
  syncKaiBottomChromeVisibilityToScroll,
  useKaiBottomChromeElementTranslation,
  useKaiBottomChromeVisibility,
} from "@/lib/navigation/kai-bottom-chrome-visibility";

// Drives the singleton's rAF-based progress animation to completion under fake
// timers. The animation uses an exponential approach, so we step several frames.
function flushAnimation(frames = 60, frameMs = 16) {
  for (let i = 0; i < frames; i += 1) {
    act(() => {
      vi.advanceTimersByTime(frameMs);
    });
  }
}

function mountScrollRoot(initialScrollTop = 0): HTMLDivElement {
  const root = document.createElement("div");
  root.dataset.appScrollRoot = "true";
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    writable: true,
    value: initialScrollTop,
  });
  document.body.append(root);
  return root;
}

describe("kai bottom chrome visibility singleton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom rAF is timer-backed; ensure a clean window scroll baseline.
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(window, "pageYOffset", {
      configurable: true,
      writable: true,
      value: 0,
    });
    resetKaiBottomChromeVisibility();
  });

  afterEach(() => {
    resetKaiBottomChromeVisibility();
    document.querySelectorAll('[data-app-scroll-root="true"]').forEach((root) => {
      root.remove();
    });
    vi.useRealTimers();
  });

  it("hides chrome (progress -> 1) on downward scroll and shows it on upward scroll", () => {
    const { result } = renderHook(() => useKaiBottomChromeVisibility(true));

    // Initialize at top, then scroll down past the hide threshold.
    act(() => onScroll(0));
    act(() => onScroll(120));
    flushAnimation();
    expect(result.current.progress).toBeGreaterThan(0.9);

    // Scroll back up: chrome returns to its mean (shown) position.
    act(() => onScroll(40));
    flushAnimation();
    expect(result.current.progress).toBeLessThan(0.1);
  });

  it("settles a fixed sibling into the bottom-nav slot through shared CSS motion", () => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const elementRef = { current: probe };
    const { unmount } = renderHook(() =>
      useKaiBottomChromeElementTranslation(elementRef, true),
    );

    expect(probe.style.transform).toBe(
      "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)",
    );

    unmount();
    probe.remove();
  });

  it("returns to mean position when a transient consumer remounts at the top after the singleton was left stuck hidden", () => {
    // Simulate the agent-bar lifecycle: it subscribes, the user scrolls down so
    // the singleton freezes at progress = 1, then the agent window opens and the
    // bar unmounts (without resetting the singleton because other consumers keep
    // the refcount > 0), then the bar remounts after the agent closes.

    // 1. A long-lived consumer keeps the singleton subscribed.
    const longLived = renderHook(() => useKaiBottomChromeVisibility(true));

    // 2. The transient consumer (agent bar) mounts.
    const transient = renderHook(() => useKaiBottomChromeVisibility(true));

    // 3. User scrolls down -> singleton freezes hidden.
    act(() => onScroll(0));
    act(() => onScroll(200));
    flushAnimation();
    expect(transient.result.current.progress).toBeGreaterThan(0.9);

    // 4. The transient consumer unmounts (agent window open). The singleton is
    //    NOT reset because the long-lived consumer keeps refcount > 0.
    transient.unmount();
    expect(longLived.result.current.progress).toBeGreaterThan(0.9);

    // 5. The user is now back at the top (e.g. scrolled inside the agent window,
    //    not the real root), so the real scroll position is at the top again.
    window.scrollY = 0;
    window.pageYOffset = 0;

    // 6. The transient consumer remounts after the agent closes. Its enable
    //    effect re-syncs the singleton to the real scroll position.
    const remounted = renderHook(() => useKaiBottomChromeVisibility(true));
    flushAnimation();

    // The bar is back at its mean position instead of stuck hidden.
    expect(remounted.result.current.progress).toBeLessThan(0.1);

    longLived.unmount();
    remounted.unmount();
  });

  it("preserves a genuinely hidden state when re-syncing while still scrolled down", () => {
    const longLived = renderHook(() => useKaiBottomChromeVisibility(true));

    act(() => onScroll(0));
    act(() => onScroll(200));
    flushAnimation();
    expect(longLived.result.current.progress).toBeGreaterThan(0.9);

    // Re-sync while the active scroll target is still scrolled down: the hidden
    // state must NOT be forced back to shown.
    window.scrollY = 200;
    window.pageYOffset = 200;
    act(() => syncKaiBottomChromeVisibilityToScroll());
    flushAnimation();
    expect(longLived.result.current.progress).toBeGreaterThan(0.9);

    longLived.unmount();
  });

  it("rebinds when route settlement replaces the app scroll root", async () => {
    const firstRoot = mountScrollRoot();
    const { result, unmount } = renderHook(() =>
      useKaiBottomChromeVisibility(true),
    );

    act(() => {
      firstRoot.scrollTop = 0;
      firstRoot.dispatchEvent(new Event("scroll"));
      firstRoot.scrollTop = 160;
      firstRoot.dispatchEvent(new Event("scroll"));
    });
    flushAnimation();
    expect(result.current.progress).toBeGreaterThan(0.9);

    firstRoot.remove();
    const secondRoot = mountScrollRoot();
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(16);
    });
    expect(result.current.progress).toBeLessThan(0.1);

    act(() => {
      secondRoot.scrollTop = 120;
      secondRoot.dispatchEvent(new Event("scroll"));
    });
    flushAnimation();
    expect(result.current.progress).toBeGreaterThan(0.9);

    unmount();
  });
});
