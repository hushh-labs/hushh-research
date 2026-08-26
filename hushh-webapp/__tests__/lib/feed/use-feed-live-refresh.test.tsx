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

    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops polling while the tab is hidden and catches up on return", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));

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

    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-checks when something was acted on, but not when rows were only marked read", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));

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

    rerender({ fn: second });
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
