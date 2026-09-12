/**
 * Cross-platform transcript and speech-adapter contracts.
 *
 * A speech provider is an input adapter only. It does not decide which
 * Hushh action a person means and it never receives action authority. The
 * bounded buffer is intentionally in-memory so an adapter can absorb a
 * short provider handoff without creating a second transcript store.
 */

export type TranscriptEventKind = "partial" | "final" | "end" | "error";

export type TranscriptEvent = {
  sessionId: string;
  sequence: number;
  kind: TranscriptEventKind;
  text: string;
  confidence?: number;
  provider: string;
  onDevice: boolean;
  errorCode?: string;
};

export type SpeechAdapterStartOptions = {
  sessionId?: string;
  locale?: string;
  onDevice?: boolean;
  allowNetwork?: boolean;
  /** Optional short app vocabulary hints for platform ASR providers. */
  contextualStrings?: readonly string[];
};

export type SpeechAdapterStartResult = {
  sessionId: string;
  provider: string;
  onDevice: boolean;
};

export type SpeechAdapterCallbacks = {
  onEvent: (event: TranscriptEvent) => void;
};

export interface OneVoiceSpeechAdapter {
  readonly provider: string;
  readonly onDevice: boolean;
  setCallbacks(callbacks: SpeechAdapterCallbacks): void;
  start(options?: SpeechAdapterStartOptions): Promise<SpeechAdapterStartResult>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

export function createSpeechSessionId(prefix = "one_voice"): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function clampTranscriptText(value: unknown, maxLength = 8_000): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export function normalizeTranscriptEvent(
  value: Partial<TranscriptEvent> | null | undefined,
): TranscriptEvent | null {
  if (!value || typeof value.sessionId !== "string" || !value.sessionId.trim()) {
    return null;
  }
  if (
    value.kind !== "partial" &&
    value.kind !== "final" &&
    value.kind !== "end" &&
    value.kind !== "error"
  ) {
    return null;
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 0
  ) {
    return null;
  }
  if (typeof value.provider !== "string" || !value.provider.trim()) return null;
  const confidence =
    typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : undefined;
  const text = clampTranscriptText(value.text);
  return {
    sessionId: value.sessionId.trim(),
    sequence: value.sequence,
    kind: value.kind,
    text,
    ...(confidence === undefined ? {} : { confidence }),
    provider: value.provider.trim(),
    onDevice: value.onDevice === true,
    ...(typeof value.errorCode === "string" && value.errorCode.trim()
      ? { errorCode: value.errorCode.trim().slice(0, 120) }
      : {}),
  };
}

/**
 * Small FIFO ring for the handoff boundary. It stores only normalized
 * transcript events and is cleared by drain/clear; it is not durable state.
 */
export class BoundedTranscriptBuffer {
  private readonly events: TranscriptEvent[] = [];

  constructor(private readonly capacity = 32) {}

  push(event: TranscriptEvent): void {
    if (this.capacity <= 0) return;
    this.events.push(event);
    while (this.events.length > this.capacity) this.events.shift();
  }

  drain(): TranscriptEvent[] {
    const drained = [...this.events];
    this.events.length = 0;
    return drained;
  }

  clear(): void {
    this.events.length = 0;
  }

  get size(): number {
    return this.events.length;
  }
}

/**
 * Generic bounded PCM ring used by platform providers that expose audio
 * frames before the relay/model setup barrier. Frames are copied on ingress
 * and discarded on drain; callers must choose the capacity for their target
 * sample rate and memory budget.
 */
export class BoundedPcmRingBuffer {
  private readonly frames: Float32Array[] = [];
  private sampleCount = 0;

  constructor(private readonly maxSamples = 24_000) {}

  push(frame: Float32Array): void {
    if (this.maxSamples <= 0 || frame.length === 0) return;
    const copy = new Float32Array(frame);
    this.frames.push(copy);
    this.sampleCount += copy.length;
    while (this.sampleCount > this.maxSamples && this.frames.length > 0) {
      const removed = this.frames.shift();
      this.sampleCount -= removed?.length || 0;
    }
  }

  drain(): Float32Array[] {
    const drained = this.frames.splice(0);
    this.sampleCount = 0;
    return drained;
  }

  clear(): void {
    this.frames.length = 0;
    this.sampleCount = 0;
  }

  get samples(): number {
    return this.sampleCount;
  }
}
