/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIndicatorSpring } from "@/lib/morphy-ux/hooks/use-indicator-spring";

type FrameCallback = (time: number) => void;

function installManualRaf() {
  let nextId = 1;
  const queue = new Map<number, FrameCallback>();

  vi.spyOn(window, "requestAnimationFrame").mockImplementation(
    (cb: FrameCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    queue.delete(id);
  });

  return {
    // Runs every callback currently queued, at the given timestamp -- exactly
    // one browser "frame". Callbacks that schedule further frames land in the
    // (now-empty) queue for the next flush, matching real rAF semantics.
    flush(time: number) {
      const callbacks = Array.from(queue.values());
      queue.clear();
      callbacks.forEach((cb) => cb(time));
    },
    pendingCount() {
      return queue.size;
    },
  };
}

describe("useIndicatorSpring", () => {
  let raf: ReturnType<typeof installManualRaf>;

  beforeEach(() => {
    raf = installManualRaf();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snaps instantly with no animation frame when instant is requested", () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() => useIndicatorSpring(onFrame));

    act(() => {
      result.current(2, { instant: true });
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(2, true);
    expect(raf.pendingCount()).toBe(0);
  });

  it("settles at the target after enough frames, without overshoot", () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() => useIndicatorSpring(onFrame));

    act(() => {
      result.current(0, { instant: true });
    });
    onFrame.mockClear();

    act(() => {
      result.current(1);
    });

    let time = 0;
    for (let i = 0; i < 200 && raf.pendingCount() > 0; i += 1) {
      time += 16;
      act(() => {
        raf.flush(time);
      });
    }

    // The loop must have converged on its own (spring reports "settled" and
    // stops scheduling frames) rather than exhausting the safety cap.
    expect(raf.pendingCount()).toBe(0);
    const lastCall = onFrame.mock.calls.at(-1);
    expect(lastCall?.[0]).toBeCloseTo(1, 5);
    expect(lastCall?.[1]).toBe(true);

    const values = onFrame.mock.calls.map((call) => call[0] as number);
    // Near-critical damping: no meaningful overshoot past the target, i.e.
    // "snappy but natural, not bouncy".
    expect(Math.max(...values)).toBeLessThanOrEqual(1.001);
  });

  it("carries velocity when re-targeted mid-flight instead of restarting from rest", () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() => useIndicatorSpring(onFrame));

    act(() => {
      result.current(0, { instant: true });
    });

    act(() => {
      result.current(1);
    });

    // Run a few real frames so the indicator is genuinely mid-flight (past
    // zero, short of one) before it gets re-targeted again.
    let time = 0;
    for (let i = 0; i < 4; i += 1) {
      time += 16;
      act(() => {
        raf.flush(time);
      });
    }
    const valueBeforeRetarget = onFrame.mock.calls.at(-1)?.[0] as number;
    expect(valueBeforeRetarget).toBeGreaterThan(0);
    expect(valueBeforeRetarget).toBeLessThan(1);

    onFrame.mockClear();
    act(() => {
      result.current(2);
    });
    time += 16;
    act(() => {
      raf.flush(time);
    });
    const valueAfterRetarget = onFrame.mock.calls[0]?.[0] as number;

    // Ground truth for "restarting from rest": a second, brand-new spring
    // that starts at rest at the exact same position and is retargeted to
    // the exact same destination (2), stepped through the exact same single
    // frame.
    const coldOnFrame = vi.fn();
    const { result: coldResult } = renderHook(() =>
      useIndicatorSpring(coldOnFrame),
    );
    act(() => {
      coldResult.current(valueBeforeRetarget, { instant: true });
    });
    act(() => {
      coldResult.current(2);
    });
    act(() => {
      raf.flush(time);
    });
    const coldValueAfterOneFrame = coldOnFrame.mock.calls[0]?.[0] as number;

    // The warm spring -- already carrying velocity from its run toward 1 --
    // must cover more ground in this one frame than the cold spring, which
    // starts that same frame from a dead stop. Restarting from rest would
    // make the two indistinguishable.
    const warmDelta = valueAfterRetarget - valueBeforeRetarget;
    const coldDelta = coldValueAfterOneFrame - valueBeforeRetarget;
    expect(warmDelta).toBeGreaterThan(coldDelta);
    expect(valueAfterRetarget).toBeLessThan(2);
  });

  it("snaps instantly when prefers-reduced-motion is set, even without the instant flag", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }),
    );

    const onFrame = vi.fn();
    const { result } = renderHook(() => useIndicatorSpring(onFrame));

    act(() => {
      result.current(3);
    });

    expect(onFrame).toHaveBeenCalledWith(3, true);
    expect(raf.pendingCount()).toBe(0);

    vi.unstubAllGlobals();
  });
});
