import { describe, expect, it, beforeEach, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  isSupported: vi.fn(() => true),
  startRealtimeAudioCapture: vi.fn(),
  stopRealtimeAudioCapture: vi.fn(),
  beginRealtimeAudioInputTurn: vi.fn(),
  endRealtimeAudioInputTurn: vi.fn(),
  addRealtimeAudioFrameListener: vi.fn(),
  addRealtimeAudioStateListener: vi.fn(),
}));

vi.mock("@/lib/capacitor/one-voice-invocation", () => ({
  OneVoiceInvocationBridge: bridge,
}));

import { NativeRealtimeAudioInput } from "@/lib/voice/native-realtime-audio-input";

type FrameListener = (frame: {
  sessionId: string;
  sequence: number;
  sampleRate: 16000;
  channels: 1;
  encoding: "pcm_s16le";
  frameCount: number;
  level: number;
  data: string;
}) => void;

type StateListener = (state: {
  sessionId: string;
  state:
    | "started"
    | "stopped"
    | "error"
    | "first_frame"
    | "activity_started"
    | "activity_ended"
    | "delivery_backpressure"
    | "sequence_gap"
    | "turn_started"
    | "turn_ended"
    | "tail_drained";
  errorCode?: string;
  turnId?: string;
  finalSequence?: number;
  cancelled?: boolean;
}) => void;

const listenerHandle = { remove: vi.fn(async () => undefined) };

describe("NativeRealtimeAudioInput PTT continuity", () => {
  let frameListener: FrameListener | null = null;
  let stateListener: StateListener | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    frameListener = null;
    stateListener = null;
    bridge.isSupported.mockReturnValue(true);
    bridge.startRealtimeAudioCapture.mockResolvedValue({
      sessionId: "native_1",
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    bridge.stopRealtimeAudioCapture.mockResolvedValue(undefined);
    bridge.beginRealtimeAudioInputTurn.mockResolvedValue({
      sessionId: "native_1",
      turnId: "turn_1",
    });
    bridge.endRealtimeAudioInputTurn.mockResolvedValue({
      sessionId: "native_1",
      turnId: "turn_1",
      finalSequence: 2,
      cancelled: false,
    });
    bridge.addRealtimeAudioFrameListener.mockImplementation(async (listener: FrameListener) => {
      frameListener = listener;
      return listenerHandle;
    });
    bridge.addRealtimeAudioStateListener.mockImplementation(async (listener: StateListener) => {
      stateListener = listener;
      return listenerHandle;
    });
  });

  it("waits for native tail_drained before resolving the PTT release", async () => {
    const onFrame = vi.fn();
    const onState = vi.fn();
    const input = new NativeRealtimeAudioInput();
    await input.start({
      sessionId: "native_1",
      requiresExplicitInputTurn: true,
      onFrame,
      onState,
    });
    expect(bridge.startRealtimeAudioCapture).toHaveBeenCalledWith({
      sessionId: "native_1",
      requiresExplicitTurn: true,
    });
    await input.beginRealtimeAudioInputTurn({
      sessionId: "native_1",
      turnId: "turn_1",
    });

    frameListener?.(pcmFrame(1));
    frameListener?.(pcmFrame(2));
    expect(onFrame).toHaveBeenCalledTimes(2);

    let resolveNativeEnd: ((value: unknown) => void) | undefined;
    bridge.endRealtimeAudioInputTurn.mockImplementation(
      () => new Promise((resolve) => { resolveNativeEnd = resolve; }),
    );
    const ending = input.endRealtimeAudioInputTurn({
      sessionId: "native_1",
      turnId: "turn_1",
      // A stale client-side count cannot override the tail-drained native one.
      finalSequence: 99,
    });
    await Promise.resolve();
    expect(bridge.endRealtimeAudioInputTurn).toHaveBeenCalledWith({
      sessionId: "native_1",
      turnId: "turn_1",
    });

    stateListener?.({
      sessionId: "native_1",
      state: "tail_drained",
      turnId: "turn_1",
      finalSequence: 2,
      cancelled: false,
    });
    resolveNativeEnd?.({
      sessionId: "native_1",
      turnId: "turn_1",
      finalSequence: 2,
      cancelled: false,
    });

    await expect(ending).resolves.toEqual({ finalSequence: 2, cancelled: false });
    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({ state: "tail_drained", finalSequence: 2 }),
    );
  });

  it("fails closed and stops native capture on a packet sequence gap", async () => {
    const onFrame = vi.fn();
    const onState = vi.fn();
    const input = new NativeRealtimeAudioInput();
    await input.start({ sessionId: "native_1", onFrame, onState });

    frameListener?.(pcmFrame(1));
    frameListener?.(pcmFrame(3));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "error",
        reason: "native_packet_sequence_gap",
      }),
    );
    expect(bridge.stopRealtimeAudioCapture).toHaveBeenCalledWith({
      sessionId: "native_1",
    });
  });

  it("preserves an explicit cancellation through the tail-drain boundary", async () => {
    const input = new NativeRealtimeAudioInput();
    await input.start({ sessionId: "native_1", onFrame: vi.fn() });
    await input.beginInputTurn({ turnId: "turn_1" });
    bridge.endRealtimeAudioInputTurn.mockResolvedValue({
      sessionId: "native_1",
      turnId: "turn_1",
      finalSequence: 0,
      cancelled: true,
    });

    const ending = input.endInputTurn({ turnId: "turn_1", cancelled: true });
    stateListener?.({
      sessionId: "native_1",
      state: "tail_drained",
      turnId: "turn_1",
      finalSequence: 0,
      cancelled: true,
    });

    await expect(ending).resolves.toEqual({ finalSequence: 0, cancelled: true });
    expect(bridge.endRealtimeAudioInputTurn).toHaveBeenCalledWith({
      sessionId: "native_1",
      turnId: "turn_1",
      cancelled: true,
    });
  });

  it("resets packet continuity for a second held command on one warm capture", async () => {
    const onFrame = vi.fn();
    const input = new NativeRealtimeAudioInput();
    await input.start({
      sessionId: "native_1",
      requiresExplicitInputTurn: true,
      onFrame,
    });
    bridge.beginRealtimeAudioInputTurn.mockImplementation(
      async ({ turnId }: { turnId: string }) => ({
        sessionId: "native_1",
        turnId,
      }),
    );
    bridge.endRealtimeAudioInputTurn.mockImplementation(
      async ({ turnId }: { turnId: string }) => ({
        sessionId: "native_1",
        turnId,
        finalSequence: 1,
        cancelled: false,
      }),
    );

    await input.beginInputTurn({ turnId: "turn_1" });
    frameListener?.(pcmFrame(1));
    const firstEnd = input.endInputTurn({ turnId: "turn_1" });
    stateListener?.({
      sessionId: "native_1",
      state: "tail_drained",
      turnId: "turn_1",
      finalSequence: 1,
      cancelled: false,
    });
    await expect(firstEnd).resolves.toEqual({ finalSequence: 1, cancelled: false });

    await input.beginInputTurn({ turnId: "turn_2" });
    // Native deliberately restarts its opaque packet counter at the PTT
    // boundary; the server command protocol does the same.
    frameListener?.(pcmFrame(1));
    const secondEnd = input.endInputTurn({ turnId: "turn_2" });
    stateListener?.({
      sessionId: "native_1",
      state: "tail_drained",
      turnId: "turn_2",
      finalSequence: 1,
      cancelled: false,
    });
    await expect(secondEnd).resolves.toEqual({ finalSequence: 1, cancelled: false });

    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy start/stop pass-through working until a caller opts into PTT", async () => {
    const onFrame = vi.fn();
    const input = new NativeRealtimeAudioInput();
    await input.start({ sessionId: "native_1", onFrame });

    frameListener?.(pcmFrame(1));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(bridge.beginRealtimeAudioInputTurn).not.toHaveBeenCalled();

    await input.stop();
    expect(bridge.stopRealtimeAudioCapture).toHaveBeenCalledWith({
      sessionId: "native_1",
    });
  });
});

function pcmFrame(sequence: number) {
  return {
    sessionId: "native_1",
    sequence,
    sampleRate: 16_000 as const,
    channels: 1 as const,
    encoding: "pcm_s16le" as const,
    frameCount: 1,
    level: 0,
    // One signed PCM16 sample. Tests never inspect or retain audio content.
    data: "AAA=",
  };
}
