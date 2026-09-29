/**
 * Decides which web events spend gtag.js's per-page GA4 event budget.
 *
 * gtag.js rate-limits GA4 events on the page with a token bucket: 20 tokens,
 * refilled at 5 per second, capped at 20 (the `grl` limiter in the served
 * gtag.js). An event that arrives with no token is aborted silently. It is
 * never batched, never requested and never reported as an error.
 *
 * One dashboard load emits dozens of `api_request_completed` hits within a few
 * seconds. Before gtag.js has loaded, every queued hit is processed in one
 * burst with nothing refilled, so any product event queued behind that burst
 * (`portfolio_viewed`, `consent_pending_loaded`) was dropped. It was lost for
 * real people and for the UAT release smoke alike.
 *
 * The limit cannot be raised. This decides who spends it: high-volume
 * operational telemetry only spends tokens above a reserve that product events
 * keep. Product events are always forwarded, and gtag stays the authority on
 * whether they are sent.
 */

export const GTAG_EVENT_BURST_CAPACITY = 20;
export const GTAG_EVENT_REFILL_PER_SECOND = 5;
/** Tokens operational telemetry must leave for product events. */
export const PRODUCT_EVENT_TOKEN_RESERVE = 8;

export type GtagHitPriority = "product" | "operational";

export interface GtagHitBudget {
  /** gtag.js is live: hits are processed as they arrive and tokens refill. */
  markLive(): void;
  /** Whether to forward this hit to gtag. Spends a token when one is available. */
  admit(priority: GtagHitPriority): boolean;
}

export function createGtagHitBudget(
  now: () => number = () => Date.now(),
): GtagHitBudget {
  let tokens = GTAG_EVENT_BURST_CAPACITY;
  // Until gtag.js is live every forwarded hit waits in dataLayer and is then
  // processed in a single burst, so nothing refills before that moment.
  let refilledAt: number | null = null;

  function refill(): void {
    if (refilledAt === null) return;
    const at = now();
    const earned = ((at - refilledAt) / 1000) * GTAG_EVENT_REFILL_PER_SECOND;
    tokens = Math.min(GTAG_EVENT_BURST_CAPACITY, tokens + earned);
    refilledAt = at;
  }

  return {
    markLive() {
      if (refilledAt === null) refilledAt = now();
    },
    admit(priority) {
      refill();
      const floor =
        priority === "operational" ? 1 + PRODUCT_EVENT_TOKEN_RESERVE : 1;
      if (tokens < floor) return priority === "product";
      tokens -= 1;
      return true;
    },
  };
}
