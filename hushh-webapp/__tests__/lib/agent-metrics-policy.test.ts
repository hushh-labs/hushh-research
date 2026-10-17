import { describe, expect, it } from "vitest";

import {
  INITIAL_METRIC_STATE,
  METRIC_INTERACTION_THRESHOLD,
  METRIC_MAX_AGE_MS,
  isMetricRelevantInteraction,
  observeInteraction,
  shouldRecalculate,
} from "@/lib/dashboard/agent-metrics-policy";

/**
 * The roster used to recompute every agent metric on EVERY cache event touching
 * the user. That is the absence of a policy rather than an aggressive one: an
 * unrelated write re-derived everything, and a user who did nothing never
 * refreshed because nothing wrote.
 *
 * These pin the two triggers and, more importantly, the reason there are two.
 */

const T0 = 1_700_000_000_000;

describe("agent metric recalculation", () => {
  it("computes on the very first read", () => {
    // Without this the first paint waits for a threshold nobody has met yet.
    expect(shouldRecalculate(INITIAL_METRIC_STATE, T0)).toBe(true);
  });

  it("does not recompute while nothing much has happened", () => {
    const state = { interactionsSinceRecompute: 1, lastRecomputedAt: T0 };
    expect(shouldRecalculate(state, T0 + 1000)).toBe(false);
  });

  it("recomputes once enough interactions have accumulated", () => {
    const state = {
      interactionsSinceRecompute: METRIC_INTERACTION_THRESHOLD,
      lastRecomputedAt: T0,
    };
    expect(shouldRecalculate(state, T0 + 1000)).toBe(true);
  });

  it("recomputes on age even when the person did nothing", () => {
    // The blind spot an interaction-only rule has: a quiet user would otherwise
    // stare at yesterday's number indefinitely.
    const state = { interactionsSinceRecompute: 0, lastRecomputedAt: T0 };
    expect(shouldRecalculate(state, T0 + METRIC_MAX_AGE_MS)).toBe(true);
  });

  it("recomputes on interactions without waiting out the timer", () => {
    // The blind spot an age-only rule has: a busy user should not wait five
    // minutes for a number that already moved.
    const state = {
      interactionsSinceRecompute: METRIC_INTERACTION_THRESHOLD,
      lastRecomputedAt: T0,
    };
    expect(shouldRecalculate(state, T0 + 1)).toBe(true);
  });

  describe("what counts as an interaction", () => {
    it.each([
      "kai_market_home:user-1",
      "KAI-MARKET-BASELINE",
      "ria_home:user-1",
      "user-1:holdings",
      "portfolio:user-1",
    ])("counts %s", (key) => {
      expect(isMetricRelevantInteraction(key)).toBe(true);
    });

    it.each(["one_location:user-1", "feed:user-1", "consent_center:user-1"])(
      "ignores %s",
      (key) => {
        // Counting every cache write is precisely how the eager behaviour arose.
        expect(isMetricRelevantInteraction(key)).toBe(false);
      },
    );
  });

  describe("observeInteraction", () => {
    it("ignores irrelevant writes entirely", () => {
      const start = { interactionsSinceRecompute: 0, lastRecomputedAt: T0 };
      const { state, recalculate } = observeInteraction(start, "feed:user-1", T0 + 10);
      expect(recalculate).toBe(false);
      expect(state.interactionsSinceRecompute).toBe(0);
    });

    it("resets the counter when it recomputes", () => {
      // Forgetting this is how a threshold silently degrades into "recompute on
      // everything, forever, after the fifth interaction".
      let state = { interactionsSinceRecompute: 0, lastRecomputedAt: T0 };
      let fired = 0;
      for (let i = 0; i < METRIC_INTERACTION_THRESHOLD * 3; i += 1) {
        const result = observeInteraction(state, "kai_market:u", T0 + i);
        state = result.state;
        if (result.recalculate) fired += 1;
      }
      expect(fired).toBe(3);
      expect(state.interactionsSinceRecompute).toBe(0);
    });

    it("stamps the recompute time so age is measured from the right instant", () => {
      const start = {
        interactionsSinceRecompute: METRIC_INTERACTION_THRESHOLD - 1,
        lastRecomputedAt: T0,
      };
      const { state } = observeInteraction(start, "kai_market:u", T0 + 999);
      expect(state.lastRecomputedAt).toBe(T0 + 999);
    });
  });

  it("takes overrides so a surface can be tighter or looser than the default", () => {
    const state = { interactionsSinceRecompute: 2, lastRecomputedAt: T0 };
    expect(shouldRecalculate(state, T0 + 1, { interactionThreshold: 2 })).toBe(true);
    expect(shouldRecalculate(state, T0 + 1, { interactionThreshold: 99 })).toBe(false);
  });
});
