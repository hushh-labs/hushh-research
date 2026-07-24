// lib/streaming/backoff.ts

/**
 * Exponential backoff with jitter for connection retries.
 *
 * Why this exists:
 *   When a server is recovering from a partial outage, every connected
 *   client retrying with the SAME fixed delay creates a "thundering
 *   herd" — N clients hammering the server in lockstep, prolonging the
 *   outage. AWS, Google, and Stripe all document the same fix:
 *   exponential backoff with random jitter so retries spread over time.
 *
 *   See: https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
 *
 * The math:
 *   delay = min(baseMs * 2^attempt, maxMs)
 *   delay *= (1 - jitter) + jitter * random()    // "equal jitter"
 *
 * For a base of 3000ms, max of 60000ms, and 50% jitter, this yields:
 *   attempt 0:  1500–3000  ms
 *   attempt 1:  3000–6000  ms
 *   attempt 2:  6000–12000 ms
 *   attempt 3: 12000–24000 ms
 *   attempt 4: 24000–48000 ms
 *   attempt 5: 30000–60000 ms (capped)
 *   attempt N: 30000–60000 ms (capped)
 */

export interface BackoffOptions {
  /** Base delay for the first retry, in milliseconds. */
  baseMs: number;
  /** Hard cap on the computed delay, in milliseconds. */
  maxMs: number;
  /**
   * Jitter factor in [0, 1].
   *   0   = deterministic (no jitter; defeats the herd-spreading goal)
   *   0.5 = "equal jitter" — result is in [delay * 0.5, delay] (default)
   *   1   = "full jitter"  — result is in [0, delay]
   */
  jitter?: number;
  /**
   * Optional random source [0, 1). Defaults to Math.random.
   * Inject for deterministic tests.
   */
  random?: () => number;
}

const DEFAULT_JITTER = 0.5;

/**
 * Compute a retry delay for the given attempt number.
 * Returns a non-negative integer number of milliseconds.
 */
export function calculateBackoffDelay(
  attempt: number,
  options: BackoffOptions
): number {
  if (!Number.isFinite(attempt) || attempt < 0) {
    throw new RangeError(
      `calculateBackoffDelay: attempt must be a non-negative finite number, got ${attempt}`
    );
  }
  if (options.baseMs < 0 || options.maxMs < 0) {
    throw new RangeError(
      `calculateBackoffDelay: baseMs and maxMs must be non-negative`
    );
  }
  if (options.maxMs < options.baseMs) {
    throw new RangeError(
      `calculateBackoffDelay: maxMs (${options.maxMs}) must be >= baseMs (${options.baseMs})`
    );
  }

  const jitter = options.jitter ?? DEFAULT_JITTER;
  if (jitter < 0 || jitter > 1) {
    throw new RangeError(
      `calculateBackoffDelay: jitter must be in [0, 1], got ${jitter}`
    );
  }

  // Math.pow(2, attempt) can overflow for huge attempts; clamp to maxMs early.
  // 2^53 baseMs is already trillions of ms, so attempts above ~53 are nonsense.
  const safeAttempt = Math.min(attempt, 53);
  const exponential = options.baseMs * Math.pow(2, safeAttempt);
  const capped = Math.min(exponential, options.maxMs);

  const random = options.random ?? Math.random;
  const factor = 1 - jitter + jitter * random();
  return Math.floor(capped * factor);
}