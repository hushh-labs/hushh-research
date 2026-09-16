import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VoiceStatePill,
  voicePhaseLabel,
  waveformStatusForPhase,
} from "@/components/one-voice/voice-state-pill";
import type { VoicePhase } from "@/lib/one-voice/session-types";

const media = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock("@/lib/morphy-ux/use-media-query", () => ({
  useMediaQuery: () => media.reducedMotion,
}));

vi.mock("@/components/agent/agent-voice-waveform", () => ({
  AgentVoiceWaveform: ({ status }: { status: string }) => (
    <div data-testid="waveform" data-status={status} />
  ),
}));

function renderPill(
  overrides: Partial<Parameters<typeof VoiceStatePill>[0]> = {},
) {
  const props = {
    phase: "listening" as VoicePhase,
    speaking: false,
    muted: false,
    degraded: false,
    level: 0.4,
    onMute: vi.fn(),
    onStop: vi.fn(),
    onInterrupt: vi.fn(),
    ...overrides,
  };
  return { ...render(<VoiceStatePill {...props} />), props };
}

beforeEach(() => {
  media.reducedMotion = false;
});

afterEach(() => cleanup());

describe("VoiceStatePill", () => {
  it("labels every phase", () => {
    const expected: Record<VoicePhase, string> = {
      idle: "Talk to One",
      connecting: "Connecting…",
      listening: "Listening",
      understanding: "Understanding",
      asking: "One is asking",
      confirming: "Confirm to continue",
      executing: "Working…",
      complete: "Done",
      error: "Something went wrong",
      paused: "Paused",
    };
    for (const [phase, label] of Object.entries(expected) as Array<
      [VoicePhase, string]
    >) {
      const view = renderPill({ phase });
      expect(screen.getByTestId("one-voice-state-label")).toHaveTextContent(
        label,
      );
      view.unmount();
    }
    expect(voicePhaseLabel("listening", { muted: true })).toBe("Muted");
    expect(
      voicePhaseLabel("asking", { speaking: true, halfDuplex: true }),
    ).toBe("Tap to interrupt");
    expect(voicePhaseLabel("asking", { speaking: true })).toBe("One is asking");
  });

  it("keeps the launcher identity on the primary control and wires the three actions", () => {
    const { props } = renderPill({ speaking: true, phase: "asking" });
    const primary = screen.getByTestId("one-voice-agent-bar-start-icon");
    expect(primary).toHaveAttribute(
      "data-native-voice-control-id",
      "one_voice_agent_bar_start",
    );
    expect(primary).toHaveAttribute("data-agent-action", "voice");
    expect(primary).toHaveAccessibleName("Interrupt One");
    fireEvent.click(primary);
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);

    const mute = screen.getByTestId("one-voice-mute");
    expect(mute).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mute);
    expect(props.onMute).toHaveBeenCalledWith(true);

    const stop = screen.getByTestId("one-voice-stop");
    expect(stop).toHaveAttribute(
      "data-native-voice-control-id",
      "one_voice_agent_bar_stop",
    );
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledTimes(1);

    for (const control of [primary, mute, stop])
      expect(control.className).toContain("h-11");
  });

  it("reports muted with aria-pressed and the Muted label", () => {
    renderPill({ muted: true });
    expect(screen.getByTestId("one-voice-mute")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("one-voice-mute")).toHaveAccessibleName(
      "Unmute microphone",
    );
    expect(screen.getByTestId("one-voice-state-label")).toHaveTextContent(
      "Muted",
    );
    expect(screen.getByTestId("waveform")).toHaveAttribute(
      "data-status",
      "muted",
    );
  });

  it("swaps the waveform for a static level bar under reduced motion", () => {
    media.reducedMotion = true;
    renderPill({ level: 0.5 });
    expect(screen.queryByTestId("waveform")).toBeNull();
    expect(screen.getByTestId("one-voice-static-level")).toBeInTheDocument();
  });

  it("shows the collapsed status line, the degraded hint and the panel toggle", () => {
    const onToggleExpanded = vi.fn();
    renderPill({
      statusLine: "You said: share with Priya",
      degraded: true,
      expanded: false,
      onToggleExpanded,
    });
    expect(screen.getByTestId("one-voice-status-line")).toHaveTextContent(
      "You said: share with Priya",
    );
    expect(screen.getByTestId("one-voice-degraded")).toBeInTheDocument();
    const toggle = screen.getByTestId("one-voice-toggle-panel");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("maps phases onto the waveform palette", () => {
    expect(
      waveformStatusForPhase("listening", { speaking: false, muted: true }),
    ).toBe("muted");
    expect(
      waveformStatusForPhase("executing", { speaking: false, muted: false }),
    ).toBe("thinking");
    expect(
      waveformStatusForPhase("asking", { speaking: true, muted: false }),
    ).toBe("speaking");
    expect(
      waveformStatusForPhase("error", { speaking: false, muted: false }),
    ).toBe("error");
  });
});
