// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  idleSchedulerTaskIds,
  registerPeriodicTask,
  resetIdleSchedulerForTests,
} from "@/lib/perf/idle-scheduler";

/**
 * One wake for everything that is due, aligned to the interval, after a frame, never
 * while hidden, caught up on return.
 */
describe("idle scheduler", () => {
  let visibility: DocumentVisibilityState = "visible";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T10:00:00.000Z"));
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(performance.now()), 16);
      return 1;
    });
  });

  afterEach(() => {
    resetIdleSchedulerForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs two tasks with the same interval in one aligned wake", async () => {
    const order: string[] = [];
    registerPeriodicTask({ id: "a", intervalMs: 45_000, run: () => void order.push(`a@${Date.now()}`) });
    vi.advanceTimersByTime(700);
    registerPeriodicTask({ id: "b", intervalMs: 45_000, run: () => void order.push(`b@${Date.now()}`) });
    expect(idleSchedulerTaskIds()).toEqual(["a", "b"]);

    await vi.advanceTimersByTimeAsync(46_000);
    expect(order).toHaveLength(2);
    const [aAt, bAt] = order.map((entry) => Number(entry.split("@")[1]));
    expect(aAt).toBe(bAt);
    // Both ran at the 45 s multiple, not 45 s after their own registration.
    expect(aAt % 45_000).toBeLessThan(100);
  });

  it("runs the task after an animation frame and a macrotask, not inside the timer", async () => {
    const ran = vi.fn();
    registerPeriodicTask({ id: "t", intervalMs: 5_000, run: ran });
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(ran).not.toHaveBeenCalled();
    // The timer fires at the 5 s multiple; the run waits for rAF (16 ms) + setTimeout(0).
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("stays silent while hidden and catches up on return", async () => {
    const ran = vi.fn();
    registerPeriodicTask({ id: "h", intervalMs: 5_000, run: ran });
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ran).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("never overlaps a task with itself and unregisters cleanly", async () => {
    let release: (() => void) | null = null;
    const ran = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const unregister = registerPeriodicTask({ id: "slow", intervalMs: 5_000, run: ran });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(ran).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(ran).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(ran).toHaveBeenCalledTimes(2);
    unregister();
    expect(idleSchedulerTaskIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it("runs an immediate task once right away, then on its cadence", async () => {
    const ran = vi.fn();
    registerPeriodicTask({ id: "i", intervalMs: 5_000, run: ran, immediate: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(ran).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(ran).toHaveBeenCalledTimes(2);
  });
});
