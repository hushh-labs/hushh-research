/**
 * Gapless playback of the relay's 24 kHz PCM16 output.
 *
 * Ported from the retired Gemini client:
 * - chunks are scheduled on the AudioContext clock, each butting against the
 *   previous one, so contiguous speech has no ramps (ramping every chunk puts
 *   a tremolo on ordinary speech);
 * - when the queue ran dry (the playhead fell behind the clock) the next
 *   chunk starts a small lead ahead of `currentTime` and fades in over a few
 *   milliseconds. Starting exactly at `currentTime` lands inside the render
 *   quantum already being computed and clicks;
 * - `fenceTurn(turnId)` is the barge-in fence: everything from that turn and
 *   earlier is stopped and late chunks for those turns are dropped. Turn ids
 *   are not orderable strings, so order is the order in which the scheduler
 *   first saw each id.
 */

import {
  OUTPUT_SAMPLE_RATE,
  pcm16ToFloat,
  rms,
} from "@/lib/one-voice/audio/pcm";

export type PlaybackAudioContext = Pick<
  AudioContext,
  | "currentTime"
  | "sampleRate"
  | "state"
  | "destination"
  | "createBuffer"
  | "createBufferSource"
  | "createGain"
  | "resume"
  | "suspend"
  | "close"
>;

type PlaybackAudioContextCtor = new (
  options?: AudioContextOptions,
) => PlaybackAudioContext;

export type LivePlaybackSchedulerOptions = {
  sampleRate?: number;
  leadMs?: number;
  fadeMs?: number;
  /** Interval for output level reports while speaking. */
  levelIntervalMs?: number;
  AudioContextImpl?: PlaybackAudioContextCtor;
  /** A context created by the caller's gesture; owned by the caller. */
  context?: PlaybackAudioContext;
};

type ActiveChunk = {
  node: AudioBufferSourceNode;
  gain: GainNode;
  turnOrder: number;
  startAt: number;
  endAt: number;
  level: number;
};

const STOP_FADE_SECONDS = 0.015;

function resolveAudioContextCtor(): PlaybackAudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const candidate =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: PlaybackAudioContextCtor })
      .webkitAudioContext;
  return (candidate as PlaybackAudioContextCtor | undefined) ?? null;
}

export class LivePlaybackScheduler {
  private readonly sampleRate: number;
  private readonly leadSeconds: number;
  private readonly fadeSeconds: number;
  private readonly levelIntervalMs: number;
  private readonly AudioContextImpl: PlaybackAudioContextCtor | null;

  private context: PlaybackAudioContext | null;
  private ownsContext: boolean;
  private playheadTime = 0;
  private active = new Set<ActiveChunk>();
  private turnOrder = new Map<string, number>();
  private nextTurnOrder = 1;
  private fencedOrder = 0;
  private underruns = 0;
  private speakingValue = false;
  private closed = false;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private lastLevel = 0;
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private levelListeners = new Set<(level: number) => void>();

  constructor(options: LivePlaybackSchedulerOptions = {}) {
    this.sampleRate = options.sampleRate ?? OUTPUT_SAMPLE_RATE;
    this.leadSeconds = (options.leadMs ?? 80) / 1000;
    this.fadeSeconds = (options.fadeMs ?? 6) / 1000;
    this.levelIntervalMs = options.levelIntervalMs ?? 50;
    this.AudioContextImpl =
      options.AudioContextImpl ?? resolveAudioContextCtor();
    this.context = options.context ?? null;
    this.ownsContext = !options.context;
    if (this.context) this.playheadTime = this.context.currentTime;
  }

  // -- observation -----------------------------------------------------------

  get speaking(): boolean {
    return this.speakingValue;
  }

  get activeChunks(): number {
    return this.active.size;
  }

  get underrunCount(): number {
    return this.underruns;
  }

  onSpeakingChanged(callback: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(callback);
    return () => {
      this.speakingListeners.delete(callback);
    };
  }

  onOutputLevel(callback: (level: number) => void): () => void {
    this.levelListeners.add(callback);
    return () => {
      this.levelListeners.delete(callback);
    };
  }

  /** The order index of a turn (assigned on first sight). */
  orderOf(turnId: string): number {
    const known = this.turnOrder.get(turnId);
    if (known !== undefined) return known;
    const order = this.nextTurnOrder;
    this.nextTurnOrder += 1;
    this.turnOrder.set(turnId, order);
    return order;
  }

  // -- scheduling ------------------------------------------------------------

  /** Queue one PCM16 chunk. Returns false when it was dropped (fenced/closed). */
  enqueue(pcm16: Uint8Array, turnId: string): boolean {
    if (this.closed) return false;
    const order = this.orderOf(turnId);
    if (order <= this.fencedOrder) return false;
    const samples = pcm16ToFloat(pcm16);
    if (samples.length === 0) return false;
    const context = this.ensureContext();
    if (!context) return false;

    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);

    const node = context.createBufferSource();
    node.buffer = buffer;
    const gain = context.createGain();
    node.connect(gain);
    gain.connect(context.destination);

    // Equal counts as dry: nothing is scheduled ahead of the clock, so starting
    // "now" would land inside the render quantum already being computed.
    const underran = this.playheadTime <= context.currentTime;
    if (underran) {
      this.playheadTime = context.currentTime + this.leadSeconds;
      this.underruns += 1;
    }
    const startAt = this.playheadTime;
    if (underran) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + this.fadeSeconds);
    }
    const duration = samples.length / this.sampleRate;
    node.start(startAt);
    this.playheadTime = startAt + duration;

    const chunk: ActiveChunk = {
      node,
      gain,
      turnOrder: order,
      startAt,
      endAt: startAt + duration,
      level: Math.min(1, rms(samples) * 2.5),
    };
    this.active.add(chunk);
    node.onended = () => {
      this.active.delete(chunk);
      this.refreshSpeaking();
    };
    this.refreshSpeaking();
    return true;
  }

  /**
   * Barge-in fence: stop every chunk from `turnId` and earlier and drop late
   * chunks for those turns. A newer turn keeps playing.
   */
  fenceTurn(turnId: string): void {
    const order = this.orderOf(turnId);
    if (order > this.fencedOrder) this.fencedOrder = order;
    this.stopChunks((chunk) => chunk.turnOrder <= this.fencedOrder);
  }

  /** Stop everything now (leaves the fence untouched). */
  flush(): void {
    this.stopChunks(() => true);
    if (this.context) this.playheadTime = this.context.currentTime;
  }

  async suspend(): Promise<void> {
    if (!this.context || this.context.state !== "running") return;
    await this.context.suspend().catch(() => undefined);
  }

  async resume(): Promise<void> {
    if (!this.context || this.context.state === "running") return;
    await this.context.resume().catch(() => undefined);
  }

  /** Release the context (if owned) and every listener. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.stopLevelTimer();
    if (this.context && this.ownsContext) {
      void this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.speakingListeners.clear();
    this.levelListeners.clear();
  }

  // -- internals -------------------------------------------------------------

  private ensureContext(): PlaybackAudioContext | null {
    if (this.context) return this.context;
    if (!this.AudioContextImpl) return null;
    this.context = new this.AudioContextImpl({ sampleRate: this.sampleRate });
    this.ownsContext = true;
    this.playheadTime = this.context.currentTime;
    return this.context;
  }

  private stopChunks(predicate: (chunk: ActiveChunk) => boolean): void {
    const context = this.context;
    for (const chunk of Array.from(this.active)) {
      if (!predicate(chunk)) continue;
      this.active.delete(chunk);
      try {
        if (context) {
          const now = context.currentTime;
          chunk.gain.gain.cancelScheduledValues(now);
          chunk.gain.gain.setValueAtTime(chunk.gain.gain.value, now);
          chunk.gain.gain.linearRampToValueAtTime(0, now + STOP_FADE_SECONDS);
          chunk.node.stop(now + STOP_FADE_SECONDS);
        } else {
          chunk.node.stop();
        }
      } catch {
        // already stopped
      }
      chunk.node.onended = null;
    }
    if (context && this.active.size === 0)
      this.playheadTime = context.currentTime;
    this.refreshSpeaking();
  }

  private refreshSpeaking(): void {
    const speaking = this.active.size > 0;
    if (speaking) this.startLevelTimer();
    else this.stopLevelTimer();
    if (speaking === this.speakingValue) return;
    this.speakingValue = speaking;
    for (const listener of this.speakingListeners) listener(speaking);
    if (!speaking) this.emitLevel(0);
  }

  private startLevelTimer(): void {
    if (this.levelTimer !== null) return;
    this.levelTimer = setInterval(() => this.tickLevel(), this.levelIntervalMs);
  }

  private stopLevelTimer(): void {
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  private tickLevel(): void {
    const context = this.context;
    if (!context || this.active.size === 0) {
      this.emitLevel(0);
      return;
    }
    const now = context.currentTime;
    let level = 0;
    for (const chunk of this.active) {
      if (now >= chunk.startAt && now < chunk.endAt) {
        level = chunk.level;
        break;
      }
    }
    this.emitLevel(level);
  }

  private emitLevel(level: number): void {
    if (level === this.lastLevel && level === 0) return;
    this.lastLevel = level;
    for (const listener of this.levelListeners) listener(level);
  }
}
