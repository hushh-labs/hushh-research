/**
 * The proactive-wake hook fires a network side effect (POST /api/one/pod/wake) on a
 * shared, costed fleet, so the load-bearing behavior is NOT "does it wake" but "does it
 * refuse to over-wake": one wake per cooldown across every surface and trigger, one
 * in-flight request coalescing a burst, and no wake at all on the fault path or on a
 * pod that is warm or not yet live. These pin exactly that.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("useProactiveAgentWake", () => {
  it("wakes on mount when the pod is active and asleep", async () => {
    await act(async () => {
      renderHook(() => useProactiveAgentWake({ state: "active", health: "sleeping" }));
    });
    expect(wakePod).toHaveBeenCalledTimes(1);
  });

  it("does not wake a warm pod, or one that is not live yet, or one that is faulted", async () => {
    for (const props of [
      { state: "active", health: "healthy" },
      { state: "connecting", health: "sleeping" },
      { state: "active", health: "unreachable" },
    ]) {
      wakePod.mockClear();
      __resetProactiveWakeForTests();
      await act(async () => {
        renderHook(() => useProactiveAgentWake(props));
      });
      expect(wakePod).not.toHaveBeenCalled();
    }
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
