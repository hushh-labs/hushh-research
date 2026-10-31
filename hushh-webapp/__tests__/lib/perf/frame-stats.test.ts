import { describe, expect, it } from "vitest";

import {
  bootRateHz,
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

  it("knows the 80 Hz panel mode", () => {
    expect(nominalHz(79.6)).toBe(80);
    expect(nominalHz(85)).toBe(80);
    expect(nominalHz(88)).toBe(90);
    expect(frameBudgetMs(80)).toBe(12.5);
  });

  it("reads the display's rate from the median boot interval, not the mean", () => {
    // A 120 Hz panel whose boot drops frames: 100 intervals on the 8.33 ms
    // cadence and 10 of 25 ms (two frames dropped each). The mean reads
    // ~102 Hz, the S24 Ultra's boot reading, which snapped to 90; the median
    // stays on the cadence.
    const intervals = [...Array.from({ length: 100 }, () => 8.33), ...Array.from({ length: 10 }, () => 25)];
    const mean = (intervals.length / intervals.reduce((a, b) => a + b, 0)) * 1000;
    expect(nominalHz(mean)).toBe(90);
    expect(nominalHz(bootRateHz(intervals)!)).toBe(120);
    // A 60 Hz boot with a 300 ms stall still reads 60.
    expect(nominalHz(bootRateHz([...Array.from({ length: 40 }, () => 16.7), 300])!)).toBe(60);
  });

  it("does not trust a boot sample that is too short or empty", () => {
    expect(bootRateHz([])).toBeNull();
    expect(bootRateHz([8.3, 8.3, 8.3])).toBeNull();
    expect(bootRateHz(Array.from({ length: 20 }, () => Number.NaN))).toBeNull();
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
