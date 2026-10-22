import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usMarketRefreshSession, useMarketLiveRefresh } from "@/lib/kai/use-market-live-refresh";
import { idleSchedulerTaskIds, resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";

let online = true;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T13:29:59Z"));
  online = true;
  visibility = "visible";
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    setTimeout(() => callback(0), 0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  resetIdleSchedulerForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("US market refresh cadence", () => {
  it.each([
    ["2026-07-14T13:29:59Z", null],
    ["2026-07-14T13:30:00Z", "2026-07-14"],
    ["2026-01-14T14:29:59Z", null],
    ["2026-01-14T14:30:00Z", "2026-01-14"],
    ["2026-07-14T20:00:00Z", null],
    ["2026-07-18T14:00:00Z", null],
    ["2026-03-09T13:30:00Z", "2026-03-09"],
    ["2026-11-02T14:30:00Z", "2026-11-02"],
  ])("uses the Eastern session for %s", (instant, expected) => {
    expect(usMarketRefreshSession(Date.parse(instant))).toBe(expected);
  });

  it("forces a fresh read at opening even after a recent pre-open cache read", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    expect(refresh).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1010);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenLastCalledWith(true);
  });

  it("refreshes news at the slower closed cadence without keeping the open cadence", async () => {
    vi.setSystemTime(new Date("2026-07-14T19:59:59Z"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_020);
    expect(refresh).toHaveBeenCalledTimes(2);
    // Bypass client snapshots for news. The server keeps closed prices cache-only.
    expect(refresh).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps closed news attempts paused while hidden or offline", async () => {
    vi.setSystemTime(new Date("2026-07-14T22:00:00Z"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    await vi.advanceTimersByTimeAsync(20);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility = "visible";
    online = false;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    online = true;
    await vi.advanceTimersByTimeAsync(120_020);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(true);
  });

  it("does not let cache-first focus events postpone scheduled closed news reads", async () => {
    vi.setSystemTime(new Date("2026-07-14T22:09:00Z"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    await vi.advanceTimersByTimeAsync(600_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_020);
    expect(refresh).toHaveBeenLastCalledWith(true);
  });

  it("catches an opening missed while hidden and coalesces resume events", async () => {
    visibility = "hidden";
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    await vi.advanceTimersByTimeAsync(240_000);
    expect(refresh).not.toHaveBeenCalled();
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith(true);
  });

  it("waits for connectivity and prevents rejected requests from becoming retry storms", async () => {
    online = false;
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    await vi.advanceTimersByTimeAsync(1010);
    expect(refresh).not.toHaveBeenCalled();
    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(20);
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a pending request and catches up if it crossed opening", async () => {
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    })).mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, "owner"));
    await vi.advanceTimersByTimeAsync(240_000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(true);
  });

  it("uses the latest callback and tears down work at owner change and unmount", async () => {
    vi.setSystemTime(new Date("2026-07-14T13:30:00Z"));
    let finish!: () => void;
    const first = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const next = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ owner, refresh }) => useMarketLiveRefresh(refresh, owner),
      { initialProps: { owner: "first", refresh: first as (force: boolean) => Promise<unknown> } },
    );
    rerender({ owner: "second", refresh: next });
    await act(async () => { finish(); });
    expect(next).toHaveBeenCalledTimes(1);
    expect(idleSchedulerTaskIds()).toHaveLength(1);
    const latest = vi.fn().mockResolvedValue(undefined);
    rerender({ owner: "second", refresh: latest });
    await vi.advanceTimersByTimeAsync(120_010);
    expect(latest).toHaveBeenCalledTimes(1);
    unmount();
    expect(idleSchedulerTaskIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event("focus"));
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("registers no work for an unauthenticated owner", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useMarketLiveRefresh(refresh, null));
    await vi.advanceTimersByTimeAsync(120_010);
    expect(refresh).not.toHaveBeenCalled();
    expect(idleSchedulerTaskIds()).toEqual([]);
  });
});
