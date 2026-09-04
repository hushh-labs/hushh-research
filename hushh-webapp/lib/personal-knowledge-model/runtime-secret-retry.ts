/**
 * Bounded, idempotent retry policy for encrypted runtime-secret vault writes.
 *
 * Saving a runtime secret (`PersonalKnowledgeModelService.storeRuntimeSecret` /
 * `removeRuntimeSecret`) is a read → modify → encrypt → commit round trip
 * against the owner's encrypted PKM vault. Two independent failure modes can
 * otherwise surface to the user as the toast "Your choice could not be saved.
 * Please try again.":
 *
 *   1. **Transient infrastructure faults** — an HTTP 5xx / 429 / 408 or a
 *      network blip on the `store-domain` POST. These make `storeDomainData`
 *      THROW. The correct response is to *replay the identical request*: the
 *      server derives its commit id deterministically from the mutation plan id,
 *      so re-sending the exact same built artifacts (same plan id + same
 *      ciphertext) is an idempotent replay, never a double write.
 *
 *   2. **A genuine version conflict** — a concurrent writer advanced the
 *      domain's content revision. `storeDomainData` RETURNS
 *      `{ success: false, conflict: true }` (it does not throw). The correct
 *      response is to *rebuild*: re-read the domain fresh, re-apply the leaf
 *      mutation, and mint a brand-new mutation plan (new plan id + bumped
 *      manifest version) before committing again.
 *
 * This module is intentionally pure and dependency-free so it is exhaustively
 * unit-testable. All I/O — sending, rebuilding, sleeping, the clock, and
 * randomness — is injected through `hooks`.
 */

/** Total commit attempts (1 initial send + 3 retries). */
export const RUNTIME_SECRET_MAX_ATTEMPTS = 4;
/** Wall-clock budget across all attempts, in milliseconds. */
export const RUNTIME_SECRET_RETRY_DEADLINE_MS = 8000;
/** Base delay for the exponential backoff, in milliseconds. */
export const RUNTIME_SECRET_RETRY_BASE_MS = 300;
/** Upper bound on any single backoff delay, in milliseconds. */
export const RUNTIME_SECRET_RETRY_MAX_DELAY_MS = 2000;

/**
 * HTTP statuses that are safe to replay identically. 5xx are server-side
 * hiccups; 429/408/425 are throttling / timeout signals. A deterministic commit
 * id makes replaying any of these idempotent.
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Network-layer failure fingerprints. `fetch` surfaces these as `TypeError`s or
 * `AbortError`s whose messages vary by runtime, so we match on substrings.
 */
const TRANSIENT_NETWORK_PATTERN =
  /(failed to fetch|networkerror|network error|load failed|connection|timed out|timeout|econnreset|econnrefused|etimedout|socket hang up|fetch failed)/i;

export type RuntimeSecretStoreErrorClass = "transient" | "fatal";

/**
 * Decide whether a thrown store error is worth an identical replay.
 *
 * Transient (replayable): configured 5xx/429/408/425 statuses parsed from a
 * `storeDomainData` throw, plus network/abort/timeout fingerprints.
 *
 * Fatal (fail fast): everything else — 4xx client errors (400/401/403/404/422),
 * our own precondition messages ("Invalid PKM credential reference.", etc.), and
 * any unrecognised error. Defaulting unknown errors to fatal keeps a genuine
 * bug from being masked behind three silent retries.
 */
export function classifyRuntimeSecretStoreError(
  error: unknown,
): RuntimeSecretStoreErrorClass {
  const status = extractStoreDomainStatus(error);
  if (status !== null) {
    return TRANSIENT_HTTP_STATUSES.has(status) ? "transient" : "fatal";
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "transient";
    }
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      return "transient";
    }
    if (TRANSIENT_NETWORK_PATTERN.test(error.message)) {
      return "transient";
    }
    return "fatal";
  }

  if (typeof error === "string" && TRANSIENT_NETWORK_PATTERN.test(error)) {
    return "transient";
  }

  return "fatal";
}

/**
 * Pull the HTTP status out of a `storeDomainData` throw, whose message is
 * `Failed to store domain data: <status> - <body>`. Returns null when the error
 * is not a store-domain HTTP failure (e.g. a network error or a precondition).
 */
function extractStoreDomainStatus(error: unknown): number | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const match = message.match(/Failed to store domain data:\s*(\d{3})/i);
  if (!match || !match[1]) {
    return null;
  }
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : null;
}

/**
 * Full-jitter exponential backoff. Returns a value uniformly random in
 * `[0, min(maxMs, baseMs * 2 ** attemptIndex))`, which spreads concurrent
 * retriers and avoids a synchronised thundering herd against the vault API.
 *
 * @param attemptIndex Zero-based index of the retry (0 = first retry).
 */
export function computeRuntimeSecretRetryDelayMs(
  attemptIndex: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const baseMs = options.baseMs ?? RUNTIME_SECRET_RETRY_BASE_MS;
  const maxMs = options.maxMs ?? RUNTIME_SECRET_RETRY_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const safeIndex = Math.max(0, Math.floor(attemptIndex));
  const exponential = baseMs * 2 ** safeIndex;
  const ceiling = Math.min(maxMs, exponential);
  return Math.max(0, Math.round(random() * ceiling));
}

export type RuntimeSecretCommitFailureReason = "conflict" | "rejected";

/**
 * Thrown when a commit fails for a reason that is NOT an identical-replay
 * candidate: an unresolved version conflict after exhausting rebuilds, or a
 * definite server rejection (`success: false` without `conflict`).
 */
export class RuntimeSecretCommitError extends Error {
  readonly reason: RuntimeSecretCommitFailureReason;
  readonly attempts: number;
  readonly result?: RuntimeSecretCommitResult;

  constructor(
    message: string,
    details: {
      reason: RuntimeSecretCommitFailureReason;
      attempts: number;
      result?: RuntimeSecretCommitResult;
    },
  ) {
    super(message);
    this.name = "RuntimeSecretCommitError";
    this.reason = details.reason;
    this.attempts = details.attempts;
    this.result = details.result;
  }
}

/** Minimal result contract the runner needs to steer the retry loop. */
export interface RuntimeSecretCommitResult {
  success: boolean;
  conflict?: boolean;
  message?: string;
}

export interface RuntimeSecretCommitHooks<T extends RuntimeSecretCommitResult> {
  /** Commit the currently-built artifacts. Called once per attempt. */
  send: () => Promise<T>;
  /**
   * React to a genuine version conflict: re-read fresh, re-apply the mutation,
   * and rebuild the commit with a new plan id. Invoked between attempts only
   * when `send` returned `{ conflict: true }`.
   */
  rebuildAfterConflict: (previousResult: T) => Promise<void>;
  /** Sleep helper (injected so tests need no real timers). */
  pause: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in milliseconds (injected for deterministic tests). */
  now: () => number;
  /** Randomness for jitter (defaults to `Math.random`). */
  random?: () => number;
}

export interface RuntimeSecretCommitOptions {
  maxAttempts?: number;
  deadlineMs?: number;
  baseMs?: number;
  maxDelayMs?: number;
}

/**
 * Drive a runtime-secret commit to a definitive outcome.
 *
 * Loop, per attempt:
 *   - `send()`.
 *     - `success` → return the result.
 *     - `conflict` → rebuild (no backoff — the world changed, it is not
 *       overloaded) and retry, or throw `RuntimeSecretCommitError` once
 *       rebuilds are exhausted.
 *     - `success: false` without `conflict` → throw `RuntimeSecretCommitError`
 *       immediately (a definite rejection, never replayable).
 *   - `send()` throws:
 *     - fatal → rethrow as-is (callers already handle these).
 *     - transient, budget remaining → back off with jitter and replay the
 *       *identical* built artifacts (idempotent via the deterministic commit id).
 *     - transient, budget exhausted → rethrow the last error.
 *
 * The method therefore always resolves to a successful result or throws — it
 * never returns `{ success: false }`, which is what closes the latent
 * "false success" toast at every call site.
 */
export async function runRuntimeSecretCommitWithRetry<
  T extends RuntimeSecretCommitResult,
>(
  hooks: RuntimeSecretCommitHooks<T>,
  options: RuntimeSecretCommitOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? RUNTIME_SECRET_MAX_ATTEMPTS);
  const deadlineMs = options.deadlineMs ?? RUNTIME_SECRET_RETRY_DEADLINE_MS;
  const baseMs = options.baseMs ?? RUNTIME_SECRET_RETRY_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? RUNTIME_SECRET_RETRY_MAX_DELAY_MS;
  const random = hooks.random ?? Math.random;
  const startedAt = hooks.now();

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const result = await hooks.send();
      if (result.success) {
        return result;
      }
      if (result.conflict === true) {
        if (attempt >= maxAttempts) {
          throw new RuntimeSecretCommitError(
            result.message ||
              "This change collided with another update. Please try again.",
            { reason: "conflict", attempts: attempt, result },
          );
        }
        await hooks.rebuildAfterConflict(result);
        // No backoff: a conflict means the vault moved on, not that it is busy.
        continue;
      }
      // success === false with no conflict: a definite, non-retryable rejection.
      throw new RuntimeSecretCommitError(
        result.message || "Your change could not be saved.",
        { reason: "rejected", attempts: attempt, result },
      );
    } catch (error) {
      if (error instanceof RuntimeSecretCommitError) {
        throw error;
      }
      if (classifyRuntimeSecretStoreError(error) === "fatal") {
        throw error;
      }
      if (attempt >= maxAttempts) {
        throw error;
      }
      const remaining = deadlineMs - (hooks.now() - startedAt);
      if (remaining <= 0) {
        throw error;
      }
      const delay = Math.min(
        computeRuntimeSecretRetryDelayMs(attempt - 1, {
          baseMs,
          maxMs: maxDelayMs,
          random,
        }),
        remaining,
      );
      await hooks.pause(delay);
      // Replay the identical built artifacts on the next iteration.
    }
  }
}
