import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEED_STATE_CHANGED_EVENT,
  dispatchFeedStateChanged,
} from "@/lib/feed/feed-events";
import {
  FEED_LIVE_POLL_INTERVAL_MS,
  FEED_PENDING_CONSENT_POLL_INTERVAL_MS,
  useFeedLiveRefresh,
  useFeedPendingConsentRefresh,
} from "@/lib/feed/use-feed-live-refresh";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";

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
    // The shared idle clock runs tasks at multiples of their interval and
    // after an animation frame; pin the clock to a multiple and make the
    // frame a fake timer so the interval arithmetic below stays exact.
    vi.setSystemTime(new Date(1789930800000));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible" as DocumentVisibilityState,
    });
  });

  afterEach(() => {
    resetIdleSchedulerForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-checks on the shared interval while the tab is visible", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));

    // Mount is itself the freshest moment to ask.
    expect(refresh).toHaveBeenCalledTimes(1);

    // The clock's wake runs the task after a frame, so a hair past the tick.
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS + 10);
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

  // Measured on UAT 2026-09-28: a consent request reached the owner's phone
  // and the Feed kept showing its old list until the 45s timer, so the
  // "Needs you" row with Allow appeared up to 45 seconds late. A consent
  // push or a decision made on another surface now re-checks at once; the
  // provider's replays of what the device already holds do not.
  it("re-checks at once on a consent push or decision, but not on a cached replay", () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();

    for (const source of ["cached_pending", "queued_pending", "hydrated_pending", "fcm_opened"]) {
      dispatchConsentStateChanged({ source });
    }
    expect(refresh).not.toHaveBeenCalled();

    dispatchConsentStateChanged({ source: "fcm_live", requestId: "req-1" });
    expect(refresh).toHaveBeenCalledTimes(1);

    dispatchConsentStateChanged({ action: "approve", requestId: "req-1", source: "consent_actions" });
    expect(refresh).toHaveBeenCalledTimes(2);
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
    vi.advanceTimersByTime(FEED_LIVE_POLL_INTERVAL_MS + 10);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

/**
 * Localhost run 2026-09-28: with no push on the web and the Feed on its 45s
 * cadence, a new request took 90.8s to appear under "Needs you". Pending
 * requests alone are now re-read every 10s while the Feed is visible.
 */
describe("useFeedPendingConsentRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1789930800000));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible" as DocumentVisibilityState,
    });
  });

  afterEach(() => {
    resetIdleSchedulerForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-reads pending requests every 10s while visible, so a new one shows within about 10s", async () => {
    const refresh = vi.fn(async () => undefined);
    renderHook(() => useFeedPendingConsentRefresh(refresh));
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS + 10);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(6);
    expect(FEED_PENDING_CONSENT_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });

  it("negative control: the 45s Feed cadence alone misses the 10s bound", async () => {
    const refresh = vi.fn();
    renderHook(() => useFeedLiveRefresh(refresh));
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS * 3 + 10);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pauses while hidden, never overlaps a slow read, and stops when disabled", async () => {
    let finish: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => useFeedPendingConsentRefresh(refresh, on),
      { initialProps: { on: true } },
    );
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS + 10);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The first read is still out (localhost measured 17s): no second one.
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    finish();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS * 6);
    expect(refresh).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(3);
    finish();

    rerender({ on: false });
    await vi.advanceTimersByTimeAsync(FEED_PENDING_CONSENT_POLL_INTERVAL_MS * 6);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
