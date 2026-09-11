"use client";

/**
 * The only PCM shape that may enter the shared real-time transport.
 *
 * Frames are intentionally opaque audio bytes here: this boundary owns no
 * transcript, interpretation, action authority, or durable audio retention.
 * Native and browser capture both normalize before calling the transport.
 */
export type OneVoicePcmFrame = {
  sessionId: string;
  sequence: number;
  sampleRate: 16_000;
  channels: 1;
  encoding: "pcm_s16le";
  bytes: Uint8Array;
};

/**
 * The native bridge only resolves an input-turn end after every pre-release
 * PCM packet has crossed the Capacitor boundary. `finalSequence` is an opaque
 * packet counter, not an audio-derived value, and lets the relay reject a
 * partial or replayed turn without retaining PCM.
 */
export type OneVoiceRealtimeAudioInputTurnEnd = {
  finalSequence: number;
  cancelled: boolean;
};

export type OneVoiceRealtimeAudioState =
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

export type OneVoiceRealtimeAudioInputCallbacks = {
  onFrame: (frame: OneVoicePcmFrame) => void;
  onState?: (input: {
    sessionId: string;
    state: OneVoiceRealtimeAudioState;
    reason?: string | null;
      timeToFirstFrameMs?: number | null;
      droppedFrames?: number | null;
      level?: number | null;
      turnId?: string | null;
      finalSequence?: number | null;
      cancelled?: boolean | null;
    }) => void;
};

/**
 * A platform microphone capture source for the provider-neutral Live
 * transport. Implementations must produce 16 kHz, mono, signed PCM16 little
 * endian and must never turn frames into an authorization-bearing transcript.
 */
export interface OneVoiceRealtimeAudioInput {
  readonly source: "ios_native_pcm" | "browser_pcm";
  start(
    options: {
      sessionId: string;
      /** Suppress native PCM until beginInputTurn for tap-to-command turns. */
      requiresExplicitInputTurn?: boolean;
    } & OneVoiceRealtimeAudioInputCallbacks,
  ): Promise<{ sessionId: string }>;
  /**
   * Optional because browser capture and legacy native callers may still own
   * their own turn boundary. Native PTT implementations use this to prevent
   * PCM captured outside an active command from reaching JavaScript.
   */
  beginInputTurn?(options: { turnId: string }): Promise<void>;
  /**
   * Resolves only after the native tail has been delivered to `onFrame` and a
   * matching `tail_drained` state was observed. Callers must use the returned
   * sequence when ending the server-side command turn.
   */
  endInputTurn?(options: {
    turnId: string;
    cancelled?: boolean;
  }): Promise<OneVoiceRealtimeAudioInputTurnEnd>;
  stop(): Promise<void>;
  cancel?(): Promise<void>;
}
