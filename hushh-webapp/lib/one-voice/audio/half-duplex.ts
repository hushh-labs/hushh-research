/**
 * Half-duplex fallback for devices without echo cancellation.
 *
 * With AEC the session is full duplex: the person can talk over One and the
 * relay's VAD handles the barge-in. Without AEC the mic hears the speaker,
 * the model hears itself, and every sentence interrupts the previous one.
 * The gate mutes outbound frames while One is speaking and for a short tail
 * afterwards (room reverb and playback latency).
 *
 * Unknown AEC counts as unavailable: the failure mode of guessing "on" is a
 * session that talks to itself, while guessing "off" only costs barge-in.
 */

export const HALF_DUPLEX_TAIL_MS = 250;

export function decideHalfDuplex(input: {
  echoCancellation: boolean | null | undefined;
  forced?: boolean;
}): boolean {
  if (input.forced) return true;
  return input.echoCancellation !== true;
}

export type HalfDuplexGateOptions = {
  tailMs?: number;
  now?: () => number;
};

function defaultNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export class HalfDuplexGate {
  private readonly tailMs: number;
  private readonly now: () => number;
  private speaking = false;
  private speakingEndedAt: number | null = null;

  constructor(options: HalfDuplexGateOptions = {}) {
    this.tailMs = options.tailMs ?? HALF_DUPLEX_TAIL_MS;
    this.now = options.now ?? defaultNow;
  }

  /** Feed the playback scheduler's speaking flag. */
  onSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.speakingEndedAt = speaking ? null : this.now();
  }

  /** Whether outbound frames are currently muted by the gate. */
  get muted(): boolean {
    if (this.speaking) return true;
    if (this.speakingEndedAt === null) return false;
    return this.now() - this.speakingEndedAt < this.tailMs;
  }

  /** True when a captured frame may go out right now. */
  allows(): boolean {
    return !this.muted;
  }

  /** Wrap a frame sink so gated frames are dropped before reaching it. */
  wrap<T>(sink: (frame: T) => void): (frame: T) => void {
    return (frame) => {
      if (this.allows()) sink(frame);
    };
  }

  reset(): void {
    this.speaking = false;
    this.speakingEndedAt = null;
  }
}
