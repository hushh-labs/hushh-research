import { describe, expect, it, vi } from "vitest";

import {
  HALF_DUPLEX_TAIL_MS,
  HalfDuplexGate,
  decideHalfDuplex,
} from "@/lib/one-voice/audio/half-duplex";

describe("decideHalfDuplex", () => {
  it("is full duplex only when the track confirms echo cancellation", () => {
    expect(decideHalfDuplex({ echoCancellation: true })).toBe(false);
    expect(decideHalfDuplex({ echoCancellation: false })).toBe(true);
    expect(decideHalfDuplex({ echoCancellation: null })).toBe(true);
    expect(decideHalfDuplex({ echoCancellation: undefined })).toBe(true);
  });

  it("can be forced on regardless of the track", () => {
    expect(decideHalfDuplex({ echoCancellation: true, forced: true })).toBe(
      true,
    );
    expect(decideHalfDuplex({ echoCancellation: true, forced: false })).toBe(
      false,
    );
  });
});

describe("HalfDuplexGate", () => {
  function gate(tailMs?: number) {
    const clock = { now: 10_000 };
    const gate = new HalfDuplexGate({
      now: () => clock.now,
      ...(tailMs !== undefined ? { tailMs } : {}),
    });
    return { clock, gate };
  }

  it("allows frames while One is silent", () => {
    const { gate: g } = gate();
    expect(g.muted).toBe(false);
    expect(g.allows()).toBe(true);
  });

  it("mutes while speaking and for 250 ms after", () => {
    const { clock, gate: g } = gate();
    g.onSpeaking(true);
    expect(g.muted).toBe(true);
    clock.now += 5000;
    expect(g.muted).toBe(true);
    g.onSpeaking(false);
    expect(g.muted).toBe(true);
    clock.now += HALF_DUPLEX_TAIL_MS - 1;
    expect(g.muted).toBe(true);
    clock.now += 1;
    expect(g.muted).toBe(false);
    expect(g.allows()).toBe(true);
  });

  it("restarts the tail when speech resumes inside it", () => {
    const { clock, gate: g } = gate(100);
    g.onSpeaking(true);
    g.onSpeaking(false);
    clock.now += 60;
    g.onSpeaking(true);
    clock.now += 60;
    expect(g.muted).toBe(true);
    g.onSpeaking(false);
    clock.now += 99;
    expect(g.muted).toBe(true);
    clock.now += 1;
    expect(g.muted).toBe(false);
  });

  it("ignores repeated speaking flags without moving the tail", () => {
    const { clock, gate: g } = gate(100);
    g.onSpeaking(true);
    g.onSpeaking(false);
    clock.now += 50;
    g.onSpeaking(false); // a duplicate must not restart the tail
    clock.now += 50;
    expect(g.muted).toBe(false);
  });

  it("wraps a frame sink so gated frames never reach it", () => {
    const { clock, gate: g } = gate();
    const sink = vi.fn();
    const send = g.wrap<Uint8Array>(sink);
    send(new Uint8Array([1]));
    g.onSpeaking(true);
    send(new Uint8Array([2]));
    g.onSpeaking(false);
    send(new Uint8Array([3]));
    clock.now += HALF_DUPLEX_TAIL_MS;
    send(new Uint8Array([4]));
    expect(sink.mock.calls.map(([frame]) => (frame as Uint8Array)[0])).toEqual([
      1, 4,
    ]);
  });

  it("reset clears the speaking state and the tail", () => {
    const { gate: g } = gate();
    g.onSpeaking(true);
    g.reset();
    expect(g.muted).toBe(false);
  });
});
