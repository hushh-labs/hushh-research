const DEFAULT_TIMEOUT_MS = 10_000;

export function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}