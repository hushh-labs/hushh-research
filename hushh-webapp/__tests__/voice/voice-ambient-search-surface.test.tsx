import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

import { VoiceAmbientSearchSurface } from "@/components/kai/voice/voice-ambient-search-surface";

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  Check: () => null,
  Loader2: () => null,
  Mic: () => null,
  MicOff: () => null,
  RotateCcw: () => null,
  Search: () => null,
  Send: () => null,
  Volume2: () => null,
  VolumeX: () => null,
  X: () => null,
}));

vi.mock("@/components/kai/voice-equalizer", () => ({
  VoiceEqualizer: () => <div data-testid="voice-equalizer" />,
}));

vi.mock("@/lib/morphy-ux/ui", () => ({
  Icon: () => <span data-testid="ambient-search-icon" />,
}));

vi.mock("@/lib/morphy-ux/utils", () => ({
  getVariantStyles: () => "variant-none-fade",
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | boolean | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

function renderSurface(
  overrides: Partial<ComponentProps<typeof VoiceAmbientSearchSurface>> = {},
) {
  const props: ComponentProps<typeof VoiceAmbientSearchSurface> = {
    mode: "idle",
    placeholder: "Analyze, dashboard, consent with Kai",
    smoothedLevel: 0,
    onOpenSearch: vi.fn(),
    onMicToggle: vi.fn(),
    ...overrides,
  };
  render(<VoiceAmbientSearchSurface {...props} />);
  return props;
}

describe("voice-ambient-search-surface", () => {
  it("starts voice from the compact searchbar control", () => {
    const props = renderSurface();

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    expect(props.onMicToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Analyze Nvidia")).toBeNull();
  });

  it("renders listening state inside the searchbar footprint", () => {
    renderSurface({
      mode: "listening",
      transcriptPreview: "Listening...",
      onMuteToggle: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(
      screen.getByRole("button", { name: "Kai voice listening" }),
    ).toBeTruthy();
    expect(screen.getByText("Listening...")).toBeTruthy();
    expect(screen.getByLabelText("Mute microphone")).toBeTruthy();
    expect(screen.getByLabelText("End voice session")).toBeTruthy();
    expect(screen.getByLabelText("Voice input level")).toBeTruthy();
  });

  it("keeps muted state compact and recoverable", () => {
    const onMuteToggle = vi.fn();
    renderSurface({
      mode: "muted",
      transcriptPreview: "Microphone muted. Tap mic to continue.",
      onMuteToggle,
      onEnd: vi.fn(),
    });

    fireEvent.click(screen.getByLabelText("Unmute microphone"));

    expect(onMuteToggle).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Microphone muted. Tap mic to continue."),
    ).toBeTruthy();
  });

  it("renders speaking controls without opening a panel", () => {
    const onStopSpeaking = vi.fn();
    const onReplay = vi.fn();
    renderSurface({
      mode: "speaking",
      stageText: "Kai is responding...",
      ttsPlaying: true,
      onStopSpeaking,
      onReplay,
      onEnd: vi.fn(),
    });

    fireEvent.click(screen.getByLabelText("Stop speaking"));
    fireEvent.click(screen.getByLabelText("Replay last response"));

    expect(onStopSpeaking).toHaveBeenCalledTimes(1);
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it("anchors trust confirmations above the bar with explicit choices", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderSurface({
      mode: "retry_ready",
      pendingConfirmation: true,
      transcriptPreview: "Cancel the active analysis?",
      onConfirm,
      onCancel,
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.getByText("Confirm voice action")).toBeTruthy();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
