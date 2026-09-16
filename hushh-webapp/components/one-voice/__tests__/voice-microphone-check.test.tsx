import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIC_CHECK_METER_MS,
  MIC_CHECK_TONE_MS,
  VoiceMicrophoneCheck,
  formatSampleRate,
  type MicrophoneCheckCapture,
} from "@/components/one-voice/voice-microphone-check";
import type { MicrophoneProbe } from "@/lib/one-voice/audio/capture";

afterEach(() => cleanup());

function fakeAudioContext() {
  const oscillator = {
    type: "sine",
    frequency: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state: "running",
    currentTime: 0,
    sampleRate: 48_000,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
  };
  return {
    context: context as unknown as AudioContext,
    oscillator,
    gain,
    raw: context,
  };
}

function fakeCapture(
  levels: number[],
  started: { sampleRate: number; echoCancellation: boolean | null } = {
    sampleRate: 48_000,
    echoCancellation: true,
  },
): MicrophoneCheckCapture & { stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async (options) => {
      for (const level of levels) options.onLevel?.(level);
      return started;
    }),
    stop: vi.fn(),
  };
}

describe("VoiceMicrophoneCheck", () => {
  it("runs probe -> 3s meter -> 1s tone and reports the capture facts", async () => {
    const probe = vi.fn(async (): Promise<MicrophoneProbe> => ({
      ok: true,
      sampleRate: 48_000,
      echoCancellation: true,
      workletLoaded: true,
    }));
    const capture = fakeCapture([0.1, 0.35, 0.2]);
    const audio = fakeAudioContext();
    const waits: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      waits.push(ms);
    });
    const onReport = vi.fn();
    render(
      <VoiceMicrophoneCheck
        probe={probe}
        createCapture={() => capture}
        createAudioContext={() => audio.context}
        wait={wait}
        onReport={onReport}
      />,
    );
    fireEvent.click(screen.getByTestId("one-voice-microphone-check-run"));
    await waitFor(() =>
      expect(screen.getByTestId("one-voice-microphone-check")).toHaveAttribute(
        "data-phase",
        "done",
      ),
    );

    expect(probe).toHaveBeenCalledTimes(1);
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalled();
    expect(waits).toEqual([MIC_CHECK_METER_MS, MIC_CHECK_TONE_MS]);
    expect(audio.oscillator.frequency.value).toBe(440);
    expect(audio.oscillator.start).toHaveBeenCalledTimes(1);
    expect(audio.oscillator.stop).toHaveBeenCalledWith(1);
    expect(audio.raw.close).toHaveBeenCalled();

    const report = screen.getByTestId("one-voice-microphone-report");
    expect(report).toHaveTextContent("Microphone works");
    expect(
      screen.getByTestId("one-voice-microphone-sample-rate"),
    ).toHaveTextContent("48,000 Hz");
    expect(screen.getByTestId("one-voice-microphone-echo")).toHaveTextContent(
      "On",
    );
    expect(
      screen.getByTestId("one-voice-microphone-worklet"),
    ).toHaveTextContent("Loaded");
    expect(screen.getByTestId("one-voice-microphone-tone")).toHaveTextContent(
      "Played",
    );
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleRate: 48_000,
        echoCancellation: true,
        workletLoaded: true,
        heard: true,
        tonePlayed: true,
        peakLevel: 0.35,
      }),
      null,
    );
  });

  it("says nothing was heard when the level stays flat", async () => {
    const capture = fakeCapture([0, 0.005], {
      sampleRate: 44_100,
      echoCancellation: null,
    });
    render(
      <VoiceMicrophoneCheck
        probe={async () => ({
          ok: true,
          sampleRate: 44_100,
          echoCancellation: null,
          workletLoaded: true,
        })}
        createCapture={() => capture}
        createAudioContext={() => fakeAudioContext().context}
        wait={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("one-voice-microphone-check-run"));
    await waitFor(() =>
      expect(
        screen.getByTestId("one-voice-microphone-report"),
      ).toHaveTextContent("We didn't hear anything"),
    );
    expect(screen.getByTestId("one-voice-microphone-echo")).toHaveTextContent(
      "Unknown",
    );
    expect(
      screen.getByTestId("one-voice-microphone-sample-rate"),
    ).toHaveTextContent("44,100 Hz");
  });

  it("surfaces a probe failure without touching the capture path", async () => {
    const capture = fakeCapture([0.5]);
    const createCapture = vi.fn(() => capture);
    render(
      <VoiceMicrophoneCheck
        probe={async () => ({
          ok: false,
          error: {
            code: "not_allowed",
            message:
              "Microphone access is blocked. Allow the mic for this site.",
          },
        })}
        createCapture={createCapture}
        createAudioContext={() => fakeAudioContext().context}
        wait={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("one-voice-microphone-check-run"));
    await waitFor(() =>
      expect(screen.getByTestId("one-voice-microphone-check")).toHaveAttribute(
        "data-phase",
        "failed",
      ),
    );
    expect(screen.getByTestId("one-voice-microphone-report")).toHaveTextContent(
      "Microphone access is blocked.",
    );
    expect(
      screen.getByTestId("one-voice-microphone-worklet"),
    ).toHaveTextContent("Not loaded");
    expect(createCapture).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("one-voice-microphone-check-run"),
    ).toHaveTextContent("Test microphone");
  });

  it("keeps the trigger at a 44pt target and formats sample rates", () => {
    render(
      <VoiceMicrophoneCheck
        probe={async () => ({ ok: false })}
        wait={async () => undefined}
      />,
    );
    expect(
      screen.getByTestId("one-voice-microphone-check-run").className,
    ).toContain("min-h-11");
    expect(formatSampleRate(48_000)).toBe("48,000 Hz");
    expect(formatSampleRate(null)).toBe("Unknown");
  });
});
