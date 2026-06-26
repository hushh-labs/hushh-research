import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";

const reducedMotionMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/morphy-ux/gsap", () => ({
  prefersReducedMotion: () => reducedMotionMock.value,
}));

describe("AgentVoiceWaveform", () => {
  beforeEach(() => {
    reducedMotionMock.value = false;
    let id = 0;
    let framesRun = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      id += 1;
      // Drive exactly one frame synchronously so transforms get applied once,
      // without recursing into the component's self-scheduling rAF loop.
      if (framesRun === 0) {
        framesRun += 1;
        cb(16);
      }
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the requested number of bars", () => {
    const { container } = render(
      <AgentVoiceWaveform level={0.5} status="listening" barCount={12} />
    );
    const bars = container.querySelectorAll("span.origin-center");
    expect(bars).toHaveLength(12);
  });

  it("defaults to a dense bar count", () => {
    const { container } = render(
      <AgentVoiceWaveform level={0.3} status="listening" />
    );
    const bars = container.querySelectorAll("span.origin-center");
    expect(bars.length).toBe(24);
  });

  it("uses destructive styling on error", () => {
    const { container } = render(
      <AgentVoiceWaveform level={0} status="error" barCount={4} />
    );
    const bars = container.querySelectorAll("span.origin-center");
    bars.forEach((bar) => {
      expect(bar.className).toContain("bg-destructive/70");
    });
  });

  it("exposes an accessible label", () => {
    const { getByRole } = render(
      <AgentVoiceWaveform level={0.2} status="listening" barCount={4} />
    );
    expect(getByRole("img", { name: "Voice activity" })).toBeTruthy();
  });

  it("animates bars toward a nonzero scale while listening", () => {
    const { container } = render(
      <AgentVoiceWaveform level={0.9} status="listening" barCount={8} />
    );
    const bars = Array.from(
      container.querySelectorAll<HTMLSpanElement>("span.origin-center")
    );
    // After one driven frame at least one center bar should have grown beyond
    // the resting floor scale.
    const grew = bars.some((bar) => {
      const match = bar.style.transform.match(/scaleY\(([0-9.]+)\)/);
      const scale = match ? Number(match[1]) : 0;
      return scale > 0.06;
    });
    expect(grew).toBe(true);
  });

  it("honors reduced motion without scheduling continuous frames", () => {
    reducedMotionMock.value = true;
    render(<AgentVoiceWaveform level={0.5} status="listening" barCount={6} />);
    // Reduced motion path requests exactly one frame and does not loop.
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
