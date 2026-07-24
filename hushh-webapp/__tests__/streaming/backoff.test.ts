import { describe, expect, it } from "vitest";

import { calculateBackoffDelay } from "@/lib/streaming/backoff";

// All tests use a deterministic random source so the math is exact —
// no flakiness from real Math.random.
const NEVER = () => 0; // jitter contributes 0 → returns lower bound
const ALWAYS = () => 0.999_999; // jitter contributes ~max → returns upper bound

describe("calculateBackoffDelay", () => {
  describe("exponential growth", () => {
    it("doubles per attempt with jitter=0", () => {
      const opts = { baseMs: 100, maxMs: 60_000, jitter: 0, random: NEVER };
      expect(calculateBackoffDelay(0, opts)).toBe(100);
      expect(calculateBackoffDelay(1, opts)).toBe(200);
      expect(calculateBackoffDelay(2, opts)).toBe(400);
      expect(calculateBackoffDelay(3, opts)).toBe(800);
      expect(calculateBackoffDelay(4, opts)).toBe(1600);
      expect(calculateBackoffDelay(5, opts)).toBe(3200);
    });

    it("matches the documented schedule for the SSE consumer (base=3000, max=60000, jitter=0.5)", () => {
      // Verifies the worked example in the doc-comment is honest.
      const opts = { baseMs: 3000, maxMs: 60_000, jitter: 0.5 };
      const range = (attempt: number, lo: number, hi: number) => {
        const min = calculateBackoffDelay(attempt, { ...opts, random: NEVER });
        const max = calculateBackoffDelay(attempt, { ...opts, random: ALWAYS });
        expect(min).toBeGreaterThanOrEqual(lo - 1);
        expect(max).toBeLessThanOrEqual(hi);
      };
      range(0, 1500, 3000);
      range(1, 3000, 6000);
      range(2, 6000, 12_000);
      range(3, 12_000, 24_000);
      range(4, 24_000, 48_000);
      // capped from here on
      range(5, 30_000, 60_000);
      range(10, 30_000, 60_000);
    });
  });

  describe("cap enforcement", () => {
    it("caps at maxMs even for very large attempts", () => {
      const opts = { baseMs: 1000, maxMs: 60_000, jitter: 0, random: NEVER };
      expect(calculateBackoffDelay(20, opts)).toBe(60_000);
      expect(calculateBackoffDelay(50, opts)).toBe(60_000);
      expect(calculateBackoffDelay(100, opts)).toBe(60_000);
    });

    it("does not overflow for absurd attempt counts", () => {
      const opts = { baseMs: 1000, maxMs: 60_000, jitter: 0, random: NEVER };
      expect(calculateBackoffDelay(1_000_000, opts)).toBe(60_000);
      expect(Number.isFinite(calculateBackoffDelay(1_000_000, opts))).toBe(true);
    });
  });

  describe("jitter", () => {
    it("with jitter=0 returns the deterministic exponential value", () => {
      const opts = { baseMs: 1000, maxMs: 60_000, jitter: 0 };
      // Random source is irrelevant when jitter is 0
      expect(calculateBackoffDelay(2, { ...opts, random: NEVER })).toBe(4000);
      expect(calculateBackoffDelay(2, { ...opts, random: ALWAYS })).toBe(4000);
    });

    it("with jitter=0.5 yields results in [0.5x, 1.0x] of the deterministic value", () => {
      const baseMs = 1000;
      const opts = { baseMs, maxMs: 60_000, jitter: 0.5 };
      const det = baseMs * 4; // attempt 2 → 4000ms

      const lower = calculateBackoffDelay(2, { ...opts, random: NEVER });
      const upper = calculateBackoffDelay(2, { ...opts, random: ALWAYS });

      expect(lower).toBe(Math.floor(det * 0.5));
      expect(upper).toBeGreaterThanOrEqual(Math.floor(det * (0.5 + 0.5 * 0.99)));
      expect(upper).toBeLessThanOrEqual(det);
    });

    it("with jitter=1 yields full jitter — results in [0, delay]", () => {
      const opts = { baseMs: 1000, maxMs: 60_000, jitter: 1 };
      expect(calculateBackoffDelay(0, { ...opts, random: NEVER })).toBe(0);
      expect(
        calculateBackoffDelay(0, { ...opts, random: ALWAYS })
      ).toBeLessThanOrEqual(1000);
    });

    it("spreads attempts across the jitter window when sampling many runs", () => {
      // Demonstrates that jitter actually achieves its goal of spreading the herd.
      const samples = Array.from({ length: 200 }, () =>
        calculateBackoffDelay(2, { baseMs: 1000, maxMs: 60_000, jitter: 0.5 })
      );
      // All in [2000, 4000]
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(2000);
        expect(s).toBeLessThanOrEqual(4000);
      }
      // And we should see meaningful variation (>=20 unique values)
      const uniqueValues = new Set(samples).size;
      expect(uniqueValues).toBeGreaterThan(20);
    });
  });

  describe("output sanity", () => {
    it("never returns a negative or non-integer value", () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const d = calculateBackoffDelay(attempt, {
          baseMs: 100,
          maxMs: 60_000,
        });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(d)).toBe(true);
      }
    });
  });

  describe("input validation", () => {
    it("rejects negative attempts", () => {
      expect(() =>
        calculateBackoffDelay(-1, { baseMs: 100, maxMs: 60_000 })
      ).toThrow(RangeError);
    });

    it("rejects NaN / Infinity attempts", () => {
      expect(() =>
        calculateBackoffDelay(Number.NaN, { baseMs: 100, maxMs: 60_000 })
      ).toThrow(RangeError);
      expect(() =>
        calculateBackoffDelay(Number.POSITIVE_INFINITY, {
          baseMs: 100,
          maxMs: 60_000,
        })
      ).toThrow(RangeError);
    });

    it("rejects negative baseMs / maxMs", () => {
      expect(() =>
        calculateBackoffDelay(0, { baseMs: -1, maxMs: 60_000 })
      ).toThrow(RangeError);
      expect(() =>
        calculateBackoffDelay(0, { baseMs: 100, maxMs: -1 })
      ).toThrow(RangeError);
    });

    it("rejects maxMs < baseMs", () => {
      expect(() =>
        calculateBackoffDelay(0, { baseMs: 1000, maxMs: 500 })
      ).toThrow(RangeError);
    });

    it("rejects jitter outside [0, 1]", () => {
      expect(() =>
        calculateBackoffDelay(0, { baseMs: 100, maxMs: 60_000, jitter: -0.1 })
      ).toThrow(RangeError);
      expect(() =>
        calculateBackoffDelay(0, { baseMs: 100, maxMs: 60_000, jitter: 1.1 })
      ).toThrow(RangeError);
    });
  });
});