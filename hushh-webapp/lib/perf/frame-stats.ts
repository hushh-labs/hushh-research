/**
 * Frame-pacing arithmetic, with no DOM.
 *
 * Frame intervals are folded into a 1ms histogram as they arrive, so a window
 * of any length costs a fixed 128 counters and the percentiles never need the
 * raw samples. The last bin collects everything at 127ms and above; a frame
 * that long is a hitch whatever its exact length.
 */

export const FRAME_HISTOGRAM_BINS = 128;
export const HITCH_FRAME_MS = 50;

export type FrameWindowStats = {
  frames: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  over_50_count: number;
  over_budget_count: number;
  over_budget_ms: number;
  /** Time spent past the frame budget, per second of window. Apple's hitch ratio, from the web side. */
  raf_hitch_ms_per_s: number;
};

export function percentileFromHistogram(
  histogram: Uint32Array,
  count: number,
  percentile: number,
): number {
  if (count <= 0) return 0;
  const target = Math.max(1, Math.ceil((percentile / 100) * count));
  let seen = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    seen += histogram[bin] ?? 0;
    if (seen >= target) return bin;
  }
  return histogram.length - 1;
}

export class FrameAccumulator {
  count = 0;
  sumMs = 0;
  maxMs = 0;
  over50 = 0;
  overBudget = 0;
  overBudgetMs = 0;
  readonly histogram = new Uint32Array(FRAME_HISTOGRAM_BINS);

  add(deltaMs: number, budgetMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    this.count += 1;
    this.sumMs += deltaMs;
    if (deltaMs > this.maxMs) this.maxMs = deltaMs;
    if (deltaMs > HITCH_FRAME_MS) this.over50 += 1;
    const over = deltaMs - budgetMs;
    if (over > 0.5) {
      this.overBudget += 1;
      this.overBudgetMs += over;
    }
    const bin = Math.min(FRAME_HISTOGRAM_BINS - 1, Math.floor(deltaMs));
    this.histogram[bin] = (this.histogram[bin] ?? 0) + 1;
  }

  summary(durationMs: number): FrameWindowStats {
    const seconds = Math.max(0.001, durationMs / 1000);
    return {
      frames: this.count,
      mean_ms: this.count ? round(this.sumMs / this.count) : 0,
      p50_ms: percentileFromHistogram(this.histogram, this.count, 50),
      p95_ms: percentileFromHistogram(this.histogram, this.count, 95),
      p99_ms: percentileFromHistogram(this.histogram, this.count, 99),
      max_ms: round(this.maxMs),
      over_50_count: this.over50,
      over_budget_count: this.overBudget,
      over_budget_ms: round(this.overBudgetMs),
      raf_hitch_ms_per_s: round(this.overBudgetMs / seconds),
    };
  }
}

const NOMINAL_RATES = [30, 60, 90, 120] as const;
export type NominalHz = (typeof NOMINAL_RATES)[number];

/** Snap a measured requestAnimationFrame rate to the display rate it is running at. */
export function nominalHz(rawHz: number): NominalHz {
  if (!Number.isFinite(rawHz) || rawHz <= 0) return 60;
  let best: NominalHz = 60;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rate of NOMINAL_RATES) {
    const distance = Math.abs(rate - rawHz);
    if (distance < bestDistance) {
      best = rate;
      bestDistance = distance;
    }
  }
  return best;
}

export function frameBudgetMs(hz: NominalHz): number {
  return round(1000 / hz);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
