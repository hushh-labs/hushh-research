/**
 * The proactive-wake hook fires a network side effect (POST /api/one/pod/wake) on a
 * shared, costed fleet, so the load-bearing behavior is NOT "does it wake" but "does it
 * refuse to over-wake": one wake per cooldown across every surface and trigger, one
 * in-flight request coalescing a burst, and no wake at all on the fault path or on a
 * pod that is not yet live. Healthy pods retain visible-tab keepalive.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { wakePod } = vi.hoisted(() => ({ wakePod: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { wakePod } }));

const { subscribeLifecycle, getLifecycleSnapshot, lifecycleListeners } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    lifecycleListeners: listeners,
    subscribeLifecycle: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getLifecycleSnapshot: vi.fn(() => ({ state: "active" })),
  };
});
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: { subscribeLifecycle, getLifecycleSnapshot },
}));

import {
  __resetProactiveWakeForTests,
  useProactiveAgentWake,
} from "@/lib/feed/use-proactive-agent-wake";

beforeEach(() => {
  wakePod.mockReset();
  wakePod.mockResolvedValue({ state: "waking", etaMs: 12_000 });
  subscribeLifecycle.mockClear();
  getLifecycleSnapshot.mockReturnValue({ state: "active" });
  lifecycleListeners.clear();
  __resetProactiveWakeForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useProactiveAgentWake", () => {
  it("wakes on mount when the pod is active and asleep", async () => {
    await act(async () => {
      renderHook(() => useProactiveAgentWake({ state: "active", health: "sleeping" }));
    });
    expect(wakePod).toHaveBeenCalledTimes(1);
  });

  it("does not wake unresolved, inactive, or faulted pods", async () => {
    for (const props of [
      { state: null, health: null },
      { state: "connecting", health: "sleeping" },
      { state: "suspended", health: "sleeping" },
      { state: "active", health: "unreachable" },
      { state: "active", health: "degraded" },
    ]) {
      wakePod.mockClear();
      __resetProactiveWakeForTests();
      await act(async () => {
        renderHook(() => useProactiveAgentWake(props));
      });
      expect(wakePod).not.toHaveBeenCalled();
    }
  });

  it("keeps a healthy visible pod warm and stops the timer on a fault", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ health }) => useProactiveAgentWake({ state: "active", health }),
      { initialProps: { health: "healthy" } },
    );
    await act(async () => {});
    expect(wakePod).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
    expect(wakePod).toHaveBeenCalledTimes(2);
    rerender({ health: "unreachable" });
    await act(async () => { await vi.advanceTimersByTimeAsync(480_000); });
    expect(wakePod).toHaveBeenCalledTimes(2);
  });

  it("does not keep a healthy pod warm while the tab is hidden", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    renderHook(() => useProactiveAgentWake({ state: "active", health: "healthy" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(480_000); });
    expect(wakePod).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(wakePod).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(480_000);
    });
    expect(wakePod).toHaveBeenCalledTimes(1);
  });

  it("does not wake again within the cooldown window", async () => {
    const { result } = renderHook(() =>
      useProactiveAgentWake({ state: "active", health: "sleeping" }),
    );
    await act(async () => {}); // flush the mount wake
    expect(wakePod).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.wakeNow("composer_focus");
    });
    expect(wakePod).toHaveBeenCalledTimes(1); // cooldown suppressed the second
  });

  it("coalesces a concurrent burst of triggers into a single request", async () => {
    wakePod.mockReturnValue(new Promise(() => {})); // never resolves -> stays in flight
    const { result } = renderHook(() =>
      useProactiveAgentWake({ state: "active", health: "sleeping" }),
    );
    act(() => {
      result.current.wakeNow("a");
      result.current.wakeNow("b");
    });
    expect(wakePod).toHaveBeenCalledTimes(1);
  });

  it("surfaces isWaking while warming and clears it once the pod is awake", async () => {
    wakePod.mockResolvedValue({ state: "waking", etaMs: 12_000 });
    const warming = renderHook(() =>
      useProactiveAgentWake({ state: "active", health: "sleeping" }),
    );
    await act(async () => {});
    expect(warming.result.current.isWaking).toBe(true);

    __resetProactiveWakeForTests();
    wakePod.mockResolvedValue({ state: "awake", etaMs: 0 });
    const awake = renderHook(() =>
      useProactiveAgentWake({ state: "active", health: "sleeping" }),
    );
    await act(async () => {});
    expect(awake.result.current.isWaking).toBe(false);
  });

  it("subscribes to lifecycle and wakes on resume-to-active, not on background", async () => {
    renderHook(() => useProactiveAgentWake({ state: "active", health: "sleeping" }));
    await act(async () => {});
    expect(subscribeLifecycle).toHaveBeenCalled();

    // Fresh slate: clear the mount wake and the module cooldown so the listener's
    // effect is what we are measuring.
    wakePod.mockClear();
    __resetProactiveWakeForTests();

    getLifecycleSnapshot.mockReturnValue({ state: "background" });
    await act(async () => {
      lifecycleListeners.forEach((listener) => listener());
    });
    expect(wakePod).not.toHaveBeenCalled();

    getLifecycleSnapshot.mockReturnValue({ state: "active" });
    await act(async () => {
      lifecycleListeners.forEach((listener) => listener());
    });
    expect(wakePod).toHaveBeenCalledTimes(1);
  });
});
