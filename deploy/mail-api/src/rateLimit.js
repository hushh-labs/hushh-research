/**
 * Per-consumer rate limiting and idempotency.
 *
 * The wallet KT lists "no rate limiting" as still-open on that service — a
 * leaked key is unbounded until revoked. This service does not repeat it.
 *
 * Both stores are per-instance and in-memory. Cloud Run may run several
 * instances, so the effective ceiling is `limit x instances`. That is a real
 * limitation, not a rounding error, and it is documented in the README. It is
 * still a hard backstop against a runaway loop, which is the failure mode that
 * actually burns the Workspace daily quota.
 */

const MINUTE_MS = 60_000;

export const createRateLimiter = ({ limit, windowMs = MINUTE_MS } = {}) => {
  const buckets = new Map();

  return {
    /**
     * @param {string} consumer  key label, so one project cannot exhaust another
     * @param {number} cost      recipients in this request; Workspace bills per recipient
     */
    check(consumer, cost = 1, now = Date.now()) {
      if (!Number.isFinite(limit) || limit <= 0) return { allowed: true };

      const cutoff = now - windowMs;
      const events = (buckets.get(consumer) || []).filter((entry) => entry.at > cutoff);
      const used = events.reduce((sum, entry) => sum + entry.cost, 0);

      if (used + cost > limit) {
        const oldest = events[0]?.at ?? now;
        return {
          allowed: false,
          used,
          limit,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        };
      }

      events.push({ at: now, cost });
      buckets.set(consumer, events);

      return { allowed: true, used: used + cost, limit };
    },

    reset() {
      buckets.clear();
    },
  };
};

/**
 * Idempotency: a caller that retries after a timeout must not send twice.
 * Mirrors the `runKey` de-duplication in api/metrics/send-report.js.
 */
export const createIdempotencyStore = ({ ttlMs = 24 * 60 * MINUTE_MS } = {}) => {
  const entries = new Map();

  const sweep = (now) => {
    for (const [key, value] of entries) {
      if (now - value.at > ttlMs) entries.delete(key);
    }
  };

  return {
    get(consumer, key, now = Date.now()) {
      if (!key) return null;
      sweep(now);
      return entries.get(`${consumer}:${key}`) || null;
    },

    set(consumer, key, result, now = Date.now()) {
      if (!key) return;
      entries.set(`${consumer}:${key}`, { at: now, result });
    },

    reset() {
      entries.clear();
    },
  };
};
