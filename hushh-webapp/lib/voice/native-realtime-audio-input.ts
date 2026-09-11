"use client";

import type { PluginListenerHandle } from "@capacitor/core";

import {
  OneVoiceInvocationBridge,
  type NativeRealtimeAudioFrame,
  type NativeRealtimeAudioState,
} from "@/lib/capacitor/one-voice-invocation";
import type {
  OneVoicePcmFrame,
  OneVoiceRealtimeAudioInput,
  OneVoiceRealtimeAudioInputCallbacks,
  OneVoiceRealtimeAudioState,
  OneVoiceRealtimeAudioInputTurnEnd,
} from "@/lib/voice/realtime-audio-input";

const TAIL_DRAIN_TIMEOUT_MS = 2_000;

type TailDrain = OneVoiceRealtimeAudioInputTurnEnd;

function decodeBase64Pcm(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    if (!binary.length || binary.length % 2 !== 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    // A malformed native event has no safe recovery path. Drop the frame,
    // rather than retaining or logging any encoded audio content.
    return null;
  }
}

function mapNativeState(
  state: NativeRealtimeAudioState,
): OneVoiceRealtimeAudioState {
  return state.state;
}

/**
 * iOS AVAudioEngine input for the shared Live transport. It only forwards
 * normalized PCM frames; no Apple Speech/Fluid transcript crosses this path.
 */
export class NativeRealtimeAudioInput implements OneVoiceRealtimeAudioInput {
  readonly source = "ios_native_pcm" as const;
  private sessionId: string | null = null;
  private callbacks: OneVoiceRealtimeAudioInputCallbacks | null = null;
  private frameListener: PluginListenerHandle | null = null;
  private stateListener: PluginListenerHandle | null = null;
  private expectedPacketSequence: number | null = null;
  private activeTurnId: string | null = null;
  private failed = false;
  private readonly drainedTurns = new Map<string, TailDrain>();
  private readonly tailDrainWaiters = new Map<
    string,
    {
      resolve: (result: TailDrain) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  async start(
    options: {
      sessionId: string;
      requiresExplicitInputTurn?: boolean;
    } & OneVoiceRealtimeAudioInputCallbacks,
  ): Promise<{ sessionId: string }> {
    if (!OneVoiceInvocationBridge.isSupported()) {
      throw new Error("native_audio_unsupported");
    }
    await this.stop();
    this.sessionId = options.sessionId;
    this.callbacks = options;
    this.expectedPacketSequence = null;
    this.activeTurnId = null;
    this.failed = false;
    this.drainedTurns.clear();

    try {
      // Subscribe before enabling capture so the first PCM frame — the metric
      // that matters for the physical-device gate — cannot race past JS.
      this.frameListener = await OneVoiceInvocationBridge.addRealtimeAudioFrameListener(
        (frame) => this.handleFrame(frame),
      );
      this.stateListener = await OneVoiceInvocationBridge.addRealtimeAudioStateListener(
        (state) => this.handleState(state),
      );
      const result = await OneVoiceInvocationBridge.startRealtimeAudioCapture({
        sessionId: options.sessionId,
        ...(options.requiresExplicitInputTurn === true
          ? { requiresExplicitTurn: true }
          : {}),
      });
      if (result.sessionId !== options.sessionId) {
        throw new Error("native_audio_session_mismatch");
      }
      return { sessionId: result.sessionId };
    } catch (error) {
      // A mismatched/native-start failure must not leave AVAudioEngine owning
      // the mic after JavaScript has rejected the session. Native ignores a
      // stale id, so this is also safe when capture never actually started.
      await OneVoiceInvocationBridge.stopRealtimeAudioCapture({
        sessionId: options.sessionId,
      }).catch(() => undefined);
      await this.removeListeners();
      this.callbacks = null;
      this.sessionId = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.callbacks = null;
    this.activeTurnId = null;
    this.expectedPacketSequence = null;
    this.failed = false;
    this.rejectTailDrainWaiters("native_audio_stopped");
    this.drainedTurns.clear();
    try {
      if (sessionId) {
        await OneVoiceInvocationBridge.stopRealtimeAudioCapture({ sessionId });
      }
    } finally {
      await this.removeListeners();
    }
  }

  async cancel(): Promise<void> {
    await this.stop();
  }

  /**
   * Native begins forwarding PCM only after this PTT boundary. The raw
   * microphone can remain warm, but no idle audio is delivered to JavaScript.
   */
  async beginInputTurn(options: { turnId: string }): Promise<void> {
    const sessionId = this.requireActiveSession();
    const turnId = normalizeTurnId(options.turnId);
    if (this.failed) throw new Error("native_audio_input_failed");
    if (this.activeTurnId) throw new Error("native_audio_turn_active");

    const result = await OneVoiceInvocationBridge.beginRealtimeAudioInputTurn({
      sessionId,
      turnId,
    });
    if (result.sessionId !== sessionId || result.turnId !== turnId) {
      this.failClosed("native_audio_turn_mismatch");
      throw new Error("native_audio_turn_mismatch");
    }
    // Native packet numbers are intentionally scoped to the explicit command tap,
    // matching the relay's `location_command_begin` sequence contract.
    // A new command tap must not inherit the previous command's final packet count.
    this.expectedPacketSequence = null;
    this.drainedTurns.delete(turnId);
    this.activeTurnId = turnId;
  }

  /**
   * Compatibility spelling for the shared Live transport while it migrates to
   * `OneVoiceRealtimeAudioInput.beginInputTurn`. Keep the session assertion
   * here: a stale warm client must not begin a turn on a newer native mic.
   */
  async beginRealtimeAudioInputTurn(options: {
    sessionId: string;
    turnId: string;
  }): Promise<void> {
    if (options.sessionId !== this.requireActiveSession()) {
      throw new Error("native_audio_session_mismatch");
    }
    await this.beginInputTurn({ turnId: options.turnId });
  }

  /**
   * The Promise intentionally resolves only after native has flushed every
   * packet captured before release and emitted `tail_drained`. The caller can
   * safely send its server-side command end with this final sequence.
   */
  async endInputTurn(options: {
    turnId: string;
    cancelled?: boolean;
  }): Promise<OneVoiceRealtimeAudioInputTurnEnd> {
    const sessionId = this.requireActiveSession();
    const turnId = normalizeTurnId(options.turnId);
    if (this.failed) throw new Error("native_audio_input_failed");
    if (this.activeTurnId !== turnId) {
      throw new Error("native_audio_turn_not_active");
    }

    const tailDrained = this.waitForTailDrain(turnId);
    let result: TailDrain;
    try {
      const nativeResult = await OneVoiceInvocationBridge.endRealtimeAudioInputTurn({
        sessionId,
        turnId,
        ...(options.cancelled === true ? { cancelled: true } : {}),
      });
      if (nativeResult.sessionId !== sessionId || nativeResult.turnId !== turnId) {
        throw new Error("native_audio_turn_mismatch");
      }
      result = {
        finalSequence: nativeResult.finalSequence,
        cancelled: nativeResult.cancelled,
      };
    } catch (error) {
      this.rejectTailDrainWaiter(turnId, toError(error));
      this.failClosed("native_audio_turn_end_failed");
      throw error;
    }

    const drained = await tailDrained;
    if (
      drained.finalSequence !== result.finalSequence ||
      drained.cancelled !== result.cancelled
    ) {
      this.failClosed("native_audio_tail_mismatch");
      throw new Error("native_audio_tail_mismatch");
    }
    this.activeTurnId = null;
    return result;
  }

  /**
   * Compatibility spelling for the shared Live transport. `finalSequence`
   * from a caller is deliberately ignored: only native's tail-drained result
   * is authoritative for a server command end.
   */
  async endRealtimeAudioInputTurn(options: {
    sessionId: string;
    turnId: string;
    finalSequence?: number;
    cancelled?: boolean;
  }): Promise<OneVoiceRealtimeAudioInputTurnEnd> {
    if (options.sessionId !== this.requireActiveSession()) {
      throw new Error("native_audio_session_mismatch");
    }
    return this.endInputTurn({
      turnId: options.turnId,
      ...(options.cancelled === true ? { cancelled: true } : {}),
    });
  }

  private handleFrame(frame: NativeRealtimeAudioFrame): void {
    if (
      !this.callbacks ||
      frame.sessionId !== this.sessionId ||
      frame.sampleRate !== 16_000 ||
      frame.channels !== 1 ||
      frame.encoding !== "pcm_s16le"
    ) {
      return;
    }
    const bytes = decodeBase64Pcm(frame.data);
    if (!bytes || bytes.byteLength !== frame.frameCount * 2) {
      this.failClosed("native_pcm_frame_invalid");
      return;
    }
    const expected = this.expectedPacketSequence === null
      ? frame.sequence
      : this.expectedPacketSequence + 1;
    if (frame.sequence !== expected) {
      this.failClosed("native_packet_sequence_gap");
      return;
    }
    this.expectedPacketSequence = frame.sequence;
    const normalized: OneVoicePcmFrame = {
      sessionId: frame.sessionId,
      sequence: frame.sequence,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      bytes,
    };
    this.callbacks.onFrame(normalized);
  }

  private handleState(state: NativeRealtimeAudioState): void {
    if (!this.callbacks || state.sessionId !== this.sessionId) return;
    this.callbacks.onState?.({
      sessionId: state.sessionId,
      state: mapNativeState(state),
      reason: state.errorCode ?? null,
      timeToFirstFrameMs: state.timeToFirstFrameMs ?? null,
      droppedFrames: state.droppedFrames ?? null,
      level: state.level ?? null,
      turnId: state.turnId ?? null,
      finalSequence: state.finalSequence ?? null,
      cancelled: state.cancelled ?? null,
    });
    if (
      state.state === "tail_drained" &&
      state.turnId &&
      typeof state.finalSequence === "number"
    ) {
      const result: TailDrain = {
        finalSequence: state.finalSequence,
        cancelled: state.cancelled === true,
      };
      this.drainedTurns.set(state.turnId, result);
      const waiter = this.tailDrainWaiters.get(state.turnId);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.tailDrainWaiters.delete(state.turnId);
        waiter.resolve(result);
      }
    }
    if (
      state.state === "error" ||
      state.state === "sequence_gap" ||
      state.state === "delivery_backpressure"
    ) {
      this.failClosed(state.errorCode ?? "native_audio_delivery_failed");
    }
  }

  private waitForTailDrain(turnId: string): Promise<TailDrain> {
    const alreadyDrained = this.drainedTurns.get(turnId);
    if (alreadyDrained) return Promise.resolve(alreadyDrained);
    return new Promise<TailDrain>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.tailDrainWaiters.delete(turnId);
        const error = new Error("native_audio_tail_timeout");
        reject(error);
        this.failClosed("native_audio_tail_timeout");
      }, TAIL_DRAIN_TIMEOUT_MS);
      this.tailDrainWaiters.set(turnId, { resolve, reject, timeout });
    });
  }

  private rejectTailDrainWaiter(turnId: string, error: Error): void {
    const waiter = this.tailDrainWaiters.get(turnId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.tailDrainWaiters.delete(turnId);
    waiter.reject(error);
  }

  private rejectTailDrainWaiters(reason: string): void {
    for (const [turnId, waiter] of this.tailDrainWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
      this.tailDrainWaiters.delete(turnId);
    }
  }

  private requireActiveSession(): string {
    if (!this.sessionId || !this.callbacks) {
      throw new Error("native_audio_not_active");
    }
    return this.sessionId;
  }

  /**
   * Invalid or non-contiguous PCM is never passed on as a shorter command.
   * Stop native capture asynchronously; the visible state is the stable error
   * category rather than an audio or framework detail.
   */
  private failClosed(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.activeTurnId = null;
    this.rejectTailDrainWaiters(reason);
    const sessionId = this.sessionId;
    this.callbacks?.onState?.({
      sessionId: sessionId ?? "native_audio_failed",
      state: "error",
      reason,
    });
    if (sessionId) {
      void OneVoiceInvocationBridge.stopRealtimeAudioCapture({ sessionId }).catch(
        () => undefined,
      );
    }
  }

  private async removeListeners(): Promise<void> {
    const frameListener = this.frameListener;
    const stateListener = this.stateListener;
    this.frameListener = null;
    this.stateListener = null;
    await Promise.all([
      frameListener?.remove() ?? Promise.resolve(),
      stateListener?.remove() ?? Promise.resolve(),
    ]);
  }
}

function normalizeTurnId(value: string): string {
  const turnId = value.trim();
  if (!turnId || turnId.length > 128) {
    throw new Error("native_audio_turn_invalid");
  }
  return turnId;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("native_audio_turn_end_failed");
}

/** Null on web: GeminiLiveClient owns browser getUserMedia + AudioWorklet. */
export function createOneVoiceRealtimeAudioInput():
  | NativeRealtimeAudioInput
  | null {
  return OneVoiceInvocationBridge.isSupported()
    ? new NativeRealtimeAudioInput()
    : null;
}
