// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentVoiceEdgeGlow,
  ONE_SIRI_LEVEL_VAR,
} from "@/components/agent/agent-voice-edge-glow";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";

vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeStateOptional: () => null,
}));

/**
 * The glow used to run an unconditional requestAnimationFrame loop that set
 * React state every frame and re-rendered twelve blurred, blend-mode pools,
 * with all twelve keyframe animations still running at opacity 0 while idle.
 * The contract now: idle = no pools and no frame loop; active = pools plus a
 * single custom property written from the follower; inactive again = pools
 * gone once the exit fade is over.
 */

function flushFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    act(() => {
      vi.advanceTimersByTime(16);
    });
  }
}

describe("AgentVoiceEdgeGlow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let frame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frame += 1;
      window.setTimeout(() => cb(performance.now()), 16);
      return frame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    act(() => {
      useAgentVoiceState.getState().reset();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mounts no pools and stops its frame loop while idle", () => {
    const view = render(<AgentVoiceEdgeGlow />);
    flushFrames(3);
    expect(view.container.querySelectorAll(".one-siri-edge-pool")).toHaveLength(0);
    const raf = window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;
    const callsAfterSettle = raf.mock.calls.length;
    flushFrames(5);
    // The follower settled at 0 and did not schedule more frames.
    expect(raf.mock.calls.length).toBe(callsAfterSettle);
  });

  it("mounts twelve pools and drives one custom property while active", () => {
    const view = render(<AgentVoiceEdgeGlow />);
    act(() => {
      useAgentVoiceState.getState().setActive(true);
      useAgentVoiceState.getState().setLevel(0.8);
    });
    flushFrames(4);

    const glow = view.getByTestId("one-voice-edge-glow");
    expect(view.container.querySelectorAll(".one-siri-edge-pool")).toHaveLength(12);
    const level = Number(glow.style.getPropertyValue(ONE_SIRI_LEVEL_VAR));
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThanOrEqual(0.8);
    // No per-pool inline blur or mask: the CSS derives those from the variable.
    const pool = view.container.querySelector<HTMLElement>(".one-siri-edge-pool")!;
    expect(pool.style.filter).toBe("");
    expect(view.container.querySelector<HTMLElement>(".one-siri-edge-pools")!.style.opacity).toBe("");
  });

  it("drops the pools once the exit fade has finished", () => {
    const view = render(<AgentVoiceEdgeGlow />);
    act(() => {
      useAgentVoiceState.getState().setActive(true);
    });
    flushFrames(2);
    expect(view.container.querySelectorAll(".one-siri-edge-pool")).toHaveLength(12);

    act(() => {
      useAgentVoiceState.getState().setActive(false);
    });
    // Still mounted through the fade...
    expect(view.container.querySelectorAll(".one-siri-edge-pool")).toHaveLength(12);
    // ...and gone once the fallback deadline passes even without transitionend.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(view.container.querySelectorAll(".one-siri-edge-pool")).toHaveLength(0);
  });
});
