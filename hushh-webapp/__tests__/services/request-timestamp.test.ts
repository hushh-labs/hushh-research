import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CLOCK_DRIFT_MS,
  FUTURE_TIMESTAMP_ERROR,
  INVALID_TIMESTAMP_ERROR,
  REQUEST_TIMESTAMP_HEADER,
  getOrCreateRequestTimestampMs,
  validateHeaderTimestampConstraints,
} from "@/lib/observability/request-id";

describe("request timestamp metadata", () => {
  const runtimeClockMs = Date.parse("2026-05-23T10:30:00.000Z");

  it("accepts request timestamps within the future clock drift window", () => {
    const result = validateHeaderTimestampConstraints(
      runtimeClockMs + DEFAULT_MAX_CLOCK_DRIFT_MS,
      { nowMs: runtimeClockMs }
    );

    expect(result).toEqual({
      isSyncBlockAccepted: true,
      errorLabel: null,
    });
  });

  it("rejects request timestamps beyond the future clock drift window", () => {
    const result = validateHeaderTimestampConstraints(
      runtimeClockMs + DEFAULT_MAX_CLOCK_DRIFT_MS + 1,
      { nowMs: runtimeClockMs }
    );

    expect(result).toEqual({
      isSyncBlockAccepted: false,
      errorLabel: FUTURE_TIMESTAMP_ERROR,
    });
  });

  it("rejects malformed timestamp values", () => {
    const result = validateHeaderTimestampConstraints(Number.NaN, {
      nowMs: runtimeClockMs,
    });

    expect(result).toEqual({
      isSyncBlockAccepted: false,
      errorLabel: INVALID_TIMESTAMP_ERROR,
    });
  });

  it("normalizes future-dated request header values back to runtime time", () => {
    const headers = {
      [REQUEST_TIMESTAMP_HEADER]: String(
        runtimeClockMs + DEFAULT_MAX_CLOCK_DRIFT_MS + 1
      ),
    };

    expect(getOrCreateRequestTimestampMs(headers, runtimeClockMs)).toBe(
      runtimeClockMs
    );
  });
});
