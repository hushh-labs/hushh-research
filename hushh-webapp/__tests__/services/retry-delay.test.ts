import { describe, expect, it } from "vitest";

import {
  MINIMUM_RETRY_DELAY_MS,
  RETRY_DELAY_CONSTRAINT_ERROR,
  enforceMinimumRetryDelayMs,
  evaluateRetryIntervalConstraint,
} from "@/lib/runtime/retry-delay";

describe("retry delay constraints", () => {
  it("accepts elapsed retry intervals at the minimum boundary", () => {
    const initialExecutionTime = 1_716_500_000_000;
    const result = evaluateRetryIntervalConstraint(
      initialExecutionTime,
      initialExecutionTime + MINIMUM_RETRY_DELAY_MS
    );

    expect(result).toEqual({
      isDelayGateCompliant: true,
      elapsedMs: MINIMUM_RETRY_DELAY_MS,
      errorLabel: null,
    });
  });

  it("rejects rapid-fire retry intervals below the minimum boundary", () => {
    const initialExecutionTime = 1_716_500_000_000;
    const result = evaluateRetryIntervalConstraint(
      initialExecutionTime,
      initialExecutionTime + 50
    );

    expect(result).toEqual({
      isDelayGateCompliant: false,
      elapsedMs: 50,
      errorLabel: RETRY_DELAY_CONSTRAINT_ERROR,
    });
  });

  it("normalizes configured retry delays before runtime scheduling uses them", () => {
    expect(enforceMinimumRetryDelayMs(750)).toBe(MINIMUM_RETRY_DELAY_MS);
    expect(enforceMinimumRetryDelayMs(2000)).toBe(2000);
    expect(enforceMinimumRetryDelayMs(Number.NaN)).toBe(
      MINIMUM_RETRY_DELAY_MS
    );
  });
});
