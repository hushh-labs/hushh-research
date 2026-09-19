import { describe, expect, it } from "vitest";

import {
  FrameAccumulator,
  frameBudgetMs,
  nominalHz,
  percentileFromHistogram,
} from "@/lib/perf/frame-stats";

describe("frame-stats", () => {
  it("snaps a measured rate to the display rate it is running at", () => {
    expect(nominalHz(59.4)).toBe(60);
    expect(nominalHz(118.7)).toBe(120);
    expect(nominalHz(91)).toBe(90);
    expect(nominalHz(29)).toBe(30);
    expect(nominalHz(0)).toBe(60);
    expect(nominalHz(Number.NaN)).toBe(60);
  });

  it("derives the per-frame budget from the nominal rate", () => {
    expect(frameBudgetMs(60)).toBe(16.7);
    expect(frameBudgetMs(120)).toBe(8.3);
  });

  it("reads percentiles from the histogram without the raw samples", () => {
    const histogram = new Uint32Array(128);
    // 90 frames at 16ms, 9 at 17ms, 1 at 80ms.
    histogram[16] = 90;
    histogram[17] = 9;
    histogram[80] = 1;
    expect(percentileFromHistogram(histogram, 100, 50)).toBe(16);
    expect(percentileFromHistogram(histogram, 100, 95)).toBe(17);
    expect(percentileFromHistogram(histogram, 100, 99)).toBe(17);
    expect(percentileFromHistogram(histogram, 100, 100)).toBe(80);
    expect(percentileFromHistogram(histogram, 0, 95)).toBe(0);
  });

  it("accumulates a window and reports the hitch ratio per second", () => {
    const acc = new FrameAccumulator();
    const budget = 16.7;
    for (let i = 0; i < 58; i += 1) acc.add(16.6, budget);
    acc.add(50.2, budget); // > 50ms: a hitch
    acc.add(33.4, budget); // one dropped frame
    const stats = acc.summary(1000);

    expect(stats.frames).toBe(60);
    expect(stats.over_50_count).toBe(1);
    expect(stats.over_budget_count).toBe(2);
    expect(stats.max_ms).toBe(50.2);
    expect(stats.p50_ms).toBe(16);
    expect(stats.p99_ms).toBe(50);
    // (50.2 - 16.7) + (33.4 - 16.7) = 50.2ms over budget in a 1s window.
    expect(stats.over_budget_ms).toBe(50.2);
    expect(stats.raf_hitch_ms_per_s).toBe(50.2);
  });

  it("ignores impossible intervals and clamps long ones into the last bin", () => {
    const acc = new FrameAccumulator();
    acc.add(-1, 16.7);
    acc.add(Number.NaN, 16.7);
    acc.add(500, 16.7);
    expect(acc.count).toBe(1);
    expect(acc.histogram[127]).toBe(1);
    expect(acc.summary(500).p95_ms).toBe(127);
  });
});
