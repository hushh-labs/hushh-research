import { describe, expect, it } from "vitest";

import { SpeechEndProbe } from "@/lib/one-voice/performance";

describe("SpeechEndProbe", () => {
  it("measures only observed speech followed by held quiet and a final transcript", () => {
    const probe = new SpeechEndProbe();
    probe.observe(0.01, 100);
    probe.observe(0.01, 200);
    expect(probe.takeDuration(500)).toBeNull();

    probe.observe(0.2, 1000);
    probe.observe(0.01, 1100);
    probe.observe(0.01, 1300);
    expect(probe.takeDuration(1400)).toBeNull();

    probe.observe(0.2, 2000);
    probe.observe(0.01, 2100);
    probe.observe(0.01, 2300);
    probe.observe(0.01, 2400);
    expect(probe.takeDuration(2800)).toBe(700);
    expect(probe.takeDuration(2900)).toBeNull();
  });

  it("discards resumed speech, capture gaps, and out-of-bound durations", () => {
    const probe = new SpeechEndProbe();
    probe.observe(0.2, 0);
    probe.observe(0.01, 100);
    probe.observe(0.01, 300);
    probe.observe(0.01, 400);
    probe.observe(0.2, 450); // Speech resumed after the candidate.
    expect(probe.takeDuration(900)).toBeNull();

    probe.observe(0.2, 1000);
    probe.observe(0.01, 1100);
    probe.observe(0.01, 1500); // Missing capture callbacks cannot imply quiet.
    expect(probe.takeDuration(1600)).toBeNull();

    probe.observe(0.2, 2000);
    probe.observe(0.01, 2100);
    probe.observe(0.01, 2300);
    probe.observe(0.01, 2400);
    expect(probe.takeDuration(130_000)).toBeNull();
  });
});
