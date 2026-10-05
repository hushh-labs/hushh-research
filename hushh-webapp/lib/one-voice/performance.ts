/** Content-free, measurement-only probes for One Live Voice. */

export const PERF_MAX_DURATION_MS = 120_000;
export const PERF_TURN_ID = /^[0-9a-f]{12}$/;

const SPEECH_LEVEL = 0.12;
const QUIET_LEVEL = 0.04;
const QUIET_HOLD_MS = 300;
const MAX_CAPTURE_GAP_MS = 250;

/** A monotonic clock shared by capture, socket receive, and playback callbacks. */
export function performanceNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Approximate speech end from capture levels only. This never controls capture,
 * VAD, permissions, or actions. A candidate needs observed speech followed by
 * 300 ms of quiet; a stalled capture stream cannot manufacture a long pause.
 */
export class SpeechEndProbe {
  private speechSeen = false;
  private quietSince: number | null = null;
  private candidateAt: number | null = null;
  private lastLevelAt: number | null = null;

  observe(level: number, at: number): void {
    if (!Number.isFinite(level) || !Number.isFinite(at) || level < 0) {
      this.reset();
      return;
    }
    if (
      this.lastLevelAt !== null &&
      (at < this.lastLevelAt || at - this.lastLevelAt > MAX_CAPTURE_GAP_MS)
    ) {
      this.reset();
    }
    this.lastLevelAt = at;
    if (level >= SPEECH_LEVEL) {
      this.speechSeen = true;
      this.quietSince = null;
      this.candidateAt = null;
      return;
    }
    if (!this.speechSeen || level > QUIET_LEVEL) {
      this.quietSince = null;
      this.candidateAt = null;
      return;
    }
    this.quietSince ??= at;
    if (at - this.quietSince >= QUIET_HOLD_MS) {
      this.candidateAt = this.quietSince;
    }
  }

  /** Consume one candidate on a final microphone transcript; absent means skip. */
  takeDuration(finalReceivedAt: number): number | null {
    const candidateAt = this.candidateAt;
    this.reset();
    if (candidateAt === null) return null;
    const duration = Math.round(finalReceivedAt - candidateAt);
    return Number.isInteger(duration) &&
      duration >= 0 &&
      duration <= PERF_MAX_DURATION_MS
      ? duration
      : null;
  }

  reset(): void {
    this.speechSeen = false;
    this.quietSince = null;
    this.candidateAt = null;
    this.lastLevelAt = null;
  }
}
