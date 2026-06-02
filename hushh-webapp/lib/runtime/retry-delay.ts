export const MINIMUM_RETRY_DELAY_MS = 1000;
export const RETRY_DELAY_CONSTRAINT_ERROR =
  "CONSTRAINT_VIOLATION_IMMEDIATE_RETRY_FLOOD";

export interface RetryIntervalEvaluation {
  isDelayGateCompliant: boolean;
  elapsedMs: number;
  errorLabel: string | null;
}

export function evaluateRetryIntervalConstraint(
  initialExecutionTime: number,
  retryExecutionTime: number,
  minimumDelayMs = MINIMUM_RETRY_DELAY_MS
): RetryIntervalEvaluation {
  const elapsedMs = retryExecutionTime - initialExecutionTime;

  if (elapsedMs < minimumDelayMs) {
    return {
      isDelayGateCompliant: false,
      elapsedMs,
      errorLabel: RETRY_DELAY_CONSTRAINT_ERROR,
    };
  }

  return {
    isDelayGateCompliant: true,
    elapsedMs,
    errorLabel: null,
  };
}

export function enforceMinimumRetryDelayMs(
  requestedDelayMs: number,
  minimumDelayMs = MINIMUM_RETRY_DELAY_MS
): number {
  if (!Number.isFinite(requestedDelayMs)) {
    return minimumDelayMs;
  }

  return Math.max(minimumDelayMs, requestedDelayMs);
}
