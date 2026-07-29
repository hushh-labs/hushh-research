type ExponentialBackoffOptions = {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
};

export function getExponentialBackoffDelay({
  attempt,
  baseDelayMs = 500,
  maxDelayMs = 30000,
  jitterRatio = 0.2,
}: ExponentialBackoffOptions) {
  const safeAttempt = Math.max(0, attempt);
  const exponentialDelay = baseDelayMs * 2 ** safeAttempt;
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  const jitterRange = cappedDelay * jitterRatio;
  const jitter = Math.random() * jitterRange;

  return Math.round(cappedDelay + jitter);
}

export function getRetryAttemptLabel(attempt: number) {
  const nextAttempt = Math.max(1, attempt + 1);

  return `Retry attempt ${nextAttempt}`;
}