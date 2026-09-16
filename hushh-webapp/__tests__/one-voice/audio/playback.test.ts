import { afterEach, describe, expect, it, vi } from "vitest";

import { floatToPcm16 } from "@/lib/one-voice/audio/pcm";
import {
  LivePlaybackScheduler,
  type PlaybackAudioContext,
} from "@/lib/one-voice/audio/playback";

type GainCall = { method: string; args: number[] };

class FakeGainParam {
  value = 1;
  calls: GainCall[] = [];
  setValueAtTime(value: number, at: number) {
    this.calls.push({ method: "setValueAtTime", args: [value, at] });
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.calls.push({ method: "linearRampToValueAtTime", args: [value, at] });
  }
  cancelScheduledValues(at: number) {
    this.calls.push({ method: "cancelScheduledValues", args: [at] });
  }
}

class FakeGain {
  gain = new FakeGainParam();
  connected: unknown[] = [];
  connect(target: unknown) {
    this.connected.push(target);
  }
}

class FakeSource {
  buffer: { duration: number; length: number } | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null | "now" = null;
  onended: (() => void) | null = null;
  gain: FakeGain | null = null;
  connect(target: unknown) {
    this.gain = target as FakeGain;
  }
  start(at: number) {
    this.startedAt = at;
  }
  stop(at?: number) {
    this.stoppedAt = at === undefined ? "now" : at;
  }
  end() {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate: number;
  state: AudioContextState = "running";
  destination = { kind: "destination" };
  sources: FakeSource[] = [];
  resumed = 0;
  suspended = 0;
  closed = 0;
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24000;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: () => data,
    };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createGain() {
    return new FakeGain();
  }
  async resume() {
    this.resumed += 1;
    this.state = "running";
  }
  async suspend() {
    this.suspended += 1;
    this.state = "suspended";
  }
  async close() {
    this.closed += 1;
    this.state = "closed";
  }
}

function chunk(frames: number, amplitude = 0.5): Uint8Array {
  return floatToPcm16(new Float32Array(frames).fill(amplitude));
}

function scheduler(options: { leadMs?: number; fadeMs?: number } = {}) {
  const context = new FakeAudioContext();
  const scheduler = new LivePlaybackScheduler({
    context: context as unknown as PlaybackAudioContext,
    sampleRate: 24000,
    leadMs: options.leadMs ?? 80,
    fadeMs: options.fadeMs ?? 6,
  });
  return { context, scheduler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LivePlaybackScheduler", () => {
  it("starts the first chunk 80 ms ahead of the clock with a 6 ms fade-in", () => {
    const { context, scheduler: s } = scheduler();
    context.currentTime = 1;
    expect(s.enqueue(chunk(2400), "t1")).toBe(true);
    const source = context.sources[0]!;
    expect(source.startedAt).toBeCloseTo(1.08, 6);
    expect(source.gain!.gain.calls).toEqual([
      { method: "setValueAtTime", args: [0, 1.08] },
      { method: "linearRampToValueAtTime", args: [1, 1.086] },
    ]);
    expect(s.underrunCount).toBe(1);
  });

  it("butts contiguous chunks against each other with no ramp", () => {
    const { context, scheduler: s } = scheduler();
    context.currentTime = 0.5;
    s.enqueue(chunk(2400), "t1"); // 100 ms
    context.currentTime = 0.55; // still ahead of the playhead (0.58 + 0.1 = 0.68)
    s.enqueue(chunk(1200), "t1"); // 50 ms
    s.enqueue(chunk(1200), "t1");
    const [a, b, c] = context.sources;
    expect(a!.startedAt).toBeCloseTo(0.58, 6);
    expect(b!.startedAt).toBeCloseTo(0.68, 6);
    expect(c!.startedAt).toBeCloseTo(0.73, 6);
    expect(b!.gain!.gain.calls).toEqual([]);
    expect(c!.gain!.gain.calls).toEqual([]);
    expect(s.underrunCount).toBe(1);
  });

  it("re-leads and fades again after the queue runs dry", () => {
    const { context, scheduler: s } = scheduler({ leadMs: 100, fadeMs: 10 });
    s.enqueue(chunk(2400), "t1"); // playhead -> 0.1 + 0.1 = 0.2
    context.currentTime = 0.5; // the playhead fell behind: silence already played
    s.enqueue(chunk(2400), "t1");
    const late = context.sources[1]!;
    expect(late.startedAt).toBeCloseTo(0.6, 6);
    expect(late.gain!.gain.calls).toEqual([
      { method: "setValueAtTime", args: [0, 0.6] },
      { method: "linearRampToValueAtTime", args: [1, 0.61] },
    ]);
    expect(s.underrunCount).toBe(2);
  });

  it("reports speaking on the first chunk and clears it when every source ends", () => {
    const { context, scheduler: s } = scheduler();
    const speaking: boolean[] = [];
    s.onSpeakingChanged((value) => speaking.push(value));
    s.enqueue(chunk(240), "t1");
    s.enqueue(chunk(240), "t1");
    expect(s.speaking).toBe(true);
    expect(speaking).toEqual([true]);
    context.sources[0]!.end();
    expect(s.speaking).toBe(true);
    context.sources[1]!.end();
    expect(s.speaking).toBe(false);
    expect(speaking).toEqual([true, false]);
    expect(s.activeChunks).toBe(0);
  });

  it("fences a turn: stops its sources, drops its late chunks, keeps newer turns", () => {
    const { context, scheduler: s } = scheduler();
    context.currentTime = 2;
    s.enqueue(chunk(2400), "turn-a");
    s.enqueue(chunk(2400), "turn-b");
    s.fenceTurn("turn-a");
    const a = context.sources[0]!;
    const b = context.sources[1]!;
    expect(a.stoppedAt).toBeCloseTo(2.015, 6);
    expect(a.gain!.gain.calls.at(-1)).toEqual({
      method: "linearRampToValueAtTime",
      args: [0, 2.015],
    });
    expect(b.stoppedAt).toBeNull();
    expect(s.activeChunks).toBe(1);
    // Late audio for the fenced turn (or one seen earlier) is dropped.
    expect(s.enqueue(chunk(240), "turn-a")).toBe(false);
    expect(context.sources).toHaveLength(2);
    // The newer turn still plays.
    expect(s.enqueue(chunk(240), "turn-b")).toBe(true);
    expect(context.sources).toHaveLength(3);
    // Fencing the newer turn silences everything; a brand-new turn is fine.
    s.fenceTurn("turn-b");
    expect(s.activeChunks).toBe(0);
    expect(s.speaking).toBe(false);
    expect(s.enqueue(chunk(240), "turn-c")).toBe(true);
  });

  it("orders turns by first sight, not by id text", () => {
    const { scheduler: s } = scheduler();
    s.enqueue(chunk(240), "zzz");
    s.enqueue(chunk(240), "aaa");
    s.fenceTurn("zzz");
    expect(s.enqueue(chunk(240), "zzz")).toBe(false);
    expect(s.enqueue(chunk(240), "aaa")).toBe(true);
    expect(s.orderOf("zzz")).toBe(1);
    expect(s.orderOf("aaa")).toBe(2);
  });

  it("flush stops everything and resets the playhead but keeps the fence", () => {
    const { context, scheduler: s } = scheduler();
    context.currentTime = 1;
    s.enqueue(chunk(2400), "t1");
    s.enqueue(chunk(2400), "t1");
    s.flush();
    expect(context.sources.every((source) => source.stoppedAt !== null)).toBe(
      true,
    );
    expect(s.activeChunks).toBe(0);
    expect(s.speaking).toBe(false);
    // Next chunk re-leads from the clock.
    context.currentTime = 3;
    s.enqueue(chunk(240), "t1");
    expect(context.sources[2]!.startedAt).toBeCloseTo(3.08, 6);
  });

  it("emits output levels while a chunk is under the playhead and zero afterwards", () => {
    vi.useFakeTimers();
    const { context, scheduler: s } = scheduler();
    const levels: number[] = [];
    s.onOutputLevel((level) => levels.push(level));
    context.currentTime = 0;
    s.enqueue(chunk(2400, 0.4), "t1"); // plays 0.08 -> 0.18
    context.currentTime = 0.1;
    vi.advanceTimersByTime(50);
    expect(levels.at(-1)).toBeGreaterThan(0.5);
    context.currentTime = 0.3;
    vi.advanceTimersByTime(50);
    expect(levels.at(-1)).toBe(0);
    context.sources[0]!.end();
    expect(levels.at(-1)).toBe(0);
    vi.advanceTimersByTime(500);
    expect(levels.filter((level) => level > 0)).toHaveLength(1);
  });

  it("suspends and resumes the context and drops chunks after close", async () => {
    const { context, scheduler: s } = scheduler();
    await s.suspend();
    expect(context.suspended).toBe(1);
    await s.suspend();
    expect(context.suspended).toBe(1);
    await s.resume();
    expect(context.resumed).toBe(1);
    s.close();
    // A caller-owned context is never closed by the scheduler.
    expect(context.closed).toBe(0);
    expect(s.enqueue(chunk(240), "t1")).toBe(false);
  });

  it("creates and closes its own 24 kHz context when none is passed", () => {
    const created: FakeAudioContext[] = [];
    const Impl = class extends FakeAudioContext {
      constructor(options?: { sampleRate?: number }) {
        super(options);
        created.push(this);
      }
    };
    const s = new LivePlaybackScheduler({
      AudioContextImpl: Impl as unknown as new (
        options?: AudioContextOptions,
      ) => PlaybackAudioContext,
    });
    expect(created).toHaveLength(0);
    s.enqueue(chunk(240), "t1");
    expect(created).toHaveLength(1);
    expect(created[0]!.sampleRate).toBe(24000);
    s.close();
    expect(created[0]!.closed).toBe(1);
  });

  it("ignores empty chunks", () => {
    const { context, scheduler: s } = scheduler();
    expect(s.enqueue(new Uint8Array(), "t1")).toBe(false);
    expect(s.enqueue(new Uint8Array([1]), "t1")).toBe(false);
    expect(context.sources).toHaveLength(0);
    expect(s.speaking).toBe(false);
  });
});
