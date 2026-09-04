import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEED_STATE_CHANGED_EVENT,
  dispatchFeedStateChanged,
} from "@/lib/feed/feed-events";
import {
  FEED_LIVE_POLL_INTERVAL_MS,
  useFeedLiveRefresh,
} from "@/lib/feed/use-feed-live-refresh";

/**
 * The Feed was reported as "neither real time, not accurate and not precise".
 * It fetched once per mount and never again: the tab badge polled every 45s
 * while the list it badged asked the server nothing after the app opened.
 *
 * This pins the signal every Feed surface now shares.
 *
 * It re-checks ON MOUNT as well as on the interval. It used to start the timer
 * and nothing else, and the resource's own mount load is unforced -- so it
 * short-circuits against a cache entry that stays fresh for a full minute.
 * Landing on the Feed 59s after the last fetch therefore did no network at
 * all, and the first forced request went out 45s after that: a 105-second
 * worst case on the screen someone opened precisely to see what just happened.
 */

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useFeedLiveRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible" as DocumentVisibilityState,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-checks on the shared interval while the tab is visible", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));

    // Mount is itself the freshest moment to ask.
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("asks once on mount rather than waiting out the first interval", () => {
    // The 105s worst case, pinned. A surface that mounts visible must have
    // asked the server before any timer has run.
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-checks when a push says new activity arrived", () => {
    // A push IS the server telling us something happened. Before this the Feed
    // learned about it only from its own timer, so an event that had already
    // lit up the phone's notification tray could still be missing from the
    // list the person opened to look at it.
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();

    dispatchFeedStateChanged("arrived");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops polling while the tab is hidden and catches up on return", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));

    refresh.mockClear();

    setVisibility("hidden");
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS * 5);
    // A backgrounded tab spends battery and mobile data redrawing something
    // nobody is reading.
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    // Coming back is itself the freshest moment to re-check, so no waiting for
    // the next tick.
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("re-checks on window focus, which iOS webviews raise without a visibility change", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();

    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-checks when something was acted on, but not when rows were only marked read", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();

    // Opening the Feed marks it read. Re-fetching in response would only return
    // the rows already on screen.
    dispatchFeedStateChanged("read");
    expect(refresh).not.toHaveBeenCalled();

    // An approve/deny writes new activity, so every surface re-checks.
    dispatchFeedStateChanged("action");
    expect(refresh).toHaveBeenCalledTimes(1);

    // An untagged legacy dispatch is treated as the broader case.
    window.dispatchEvent(new CustomEvent(FEED_STATE_CHANGED_EVENT));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("defers action signals from a hidden tab until it becomes visible", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();

    setVisibility("hidden");
    dispatchFeedStateChanged("action");
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when disabled, and detaches every listener on unmount", () => {
    const disabled = vi.fn();
    renderHook(() => useFeedLiveRefresh(disabled, false));
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS * 3);
    window.dispatchEvent(new Event("focus"));
    dispatchFeedStateChanged("action");
    expect(disabled).not.toHaveBeenCalled();

    const refresh = vi.fn();
    const { unmount } = renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();
    unmount();
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS * 3);
    window.dispatchEvent(new Event("focus"));
    dispatchFeedStateChanged("action");
    setVisibility("visible");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("always calls the latest callback without rebuilding its listeners", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => useFeedLiveRefresh(fn),
      { initialProps: { fn: first } },
    );

    // `first` owns the mount call; everything after the rerender is `second`.
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ fn: second });
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
