/**
 * When should an agent's headline metric be recalculated?
 *
 * The roster's metrics were recomputed on EVERY cache event touching the user.
 * That is not a policy, it is the absence of one: a single unrelated write —
 * a location ping, a feed read, any `CacheService.set` — re-derived every
 * agent's metric, and a user who did nothing at all never refreshed because
 * nothing wrote. Both the wasted work and the staleness came from the same
 * missing idea.
 *
 * So recalculation is driven by two independent triggers, and either one fires:
 *
 *   1. **Interactions.** Enough meaningful interactions have happened since the
 *      last recompute that the metric is likely to have moved.
 *   2. **Age.** Enough wall-clock time has passed that a low-interaction user
 *      still sees something current.
 *
 * Two triggers rather than one because each covers the other's blind spot. An
 * interaction-only rule leaves a quiet user staring at yesterday's number; an
 * age-only rule makes a busy user wait out a timer for a metric that already
 * changed several interactions ago.
 *
 * What counts as an interaction is deliberately narrow — see
 * `isMetricRelevantInteraction`. Counting every cache write is how the eager
 * behaviour got here.
 */

/** A recompute is due after this many relevant interactions. */
export const METRIC_INTERACTION_THRESHOLD = 5;

/**
 * …or after this long, whichever comes first.
 *
 * Five minutes because these are dashboard summaries — a top mover, a holdings
 * count — not live quotes. Anything tighter re-derives faster than the
 * underlying caches refresh, which spends work to display the same number.
 */
export const METRIC_MAX_AGE_MS = 5 * 60 * 1000;

export type MetricRecalcState = {
  /** Relevant interactions observed since the last recompute. */
  interactionsSinceRecompute: number;
  /** `Date.now()` at the last recompute, or null if it has never run. */
  lastRecomputedAt: number | null;
};

export const INITIAL_METRIC_STATE: MetricRecalcState = {
  interactionsSinceRecompute: 0,
  lastRecomputedAt: null,
};

/**
 * Cache keys whose writes plausibly move an agent metric.
 *
 * The roster derives from market movers, RIA home, and holdings. A location
 * ping or a feed read moves none of them, and treating those as interactions is
 * what made the old behaviour eager.
 */
const METRIC_RELEVANT_KEY_FRAGMENTS = [
  "kai_market",
  "kai-market",
  "ria_home",
  "ria-home",
  "holdings",
  "portfolio",
] as const;

export function isMetricRelevantInteraction(cacheKey: string): boolean {
  const key = String(cacheKey || "").toLowerCase();
  return METRIC_RELEVANT_KEY_FRAGMENTS.some((fragment) => key.includes(fragment));
}

/**
 * Should the metrics be recalculated now?
 *
 * `now` is injected rather than read so this stays a pure function — the whole
 * point of pulling the decision out of the component is that it can be reasoned
 * about and tested without a React tree or a clock.
 */
export function shouldRecalculate(
  state: MetricRecalcState,
  now: number,
  options?: { interactionThreshold?: number; maxAgeMs?: number },
): boolean {
  const threshold = options?.interactionThreshold ?? METRIC_INTERACTION_THRESHOLD;
  const maxAgeMs = options?.maxAgeMs ?? METRIC_MAX_AGE_MS;

  // Never computed: there is nothing to show, so age and counts are irrelevant.
  // Without this the first paint would wait for a threshold nobody has met.
  if (state.lastRecomputedAt === null) return true;

  if (state.interactionsSinceRecompute >= threshold) return true;
  return now - state.lastRecomputedAt >= maxAgeMs;
}

/**
 * Fold one cache event into the state, and say whether it earned a recompute.
 *
 * Returns the state to store and the decision, so a caller never has to
 * remember to reset the counter — forgetting that is how a threshold silently
 * becomes "recompute on everything after the fifth interaction, forever".
 */
export function observeInteraction(
  state: MetricRecalcState,
  cacheKey: string,
  now: number,
  options?: { interactionThreshold?: number; maxAgeMs?: number },
): { state: MetricRecalcState; recalculate: boolean } {
  const counted = isMetricRelevantInteraction(cacheKey)
    ? state.interactionsSinceRecompute + 1
    : state.interactionsSinceRecompute;
  const next: MetricRecalcState = { ...state, interactionsSinceRecompute: counted };

  if (!shouldRecalculate(next, now, options)) {
    return { state: next, recalculate: false };
  }
  return {
    state: { interactionsSinceRecompute: 0, lastRecomputedAt: now },
    recalculate: true,
  };
}
