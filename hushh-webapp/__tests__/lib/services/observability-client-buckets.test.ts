import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import {
  toDurationBucket,
  toEventResult,
  toStatusBucket,
} from "@/lib/observability/client";

describe("toStatusBucket", () => {
  it("returns network_error for null status", () => {
    expect(toStatusBucket(null, "GET", "/api/test")).toBe("network_error");
  });

  it("buckets 200 as 2xx", () => {
    expect(toStatusBucket(200, "GET", "/api/test")).toBe("2xx");
  });

  it("buckets 301 as 3xx", () => {
    expect(toStatusBucket(301, "GET", "/api/test")).toBe("3xx");
  });

  it("returns 4xx_expected for a known expected route", () => {
    expect(
      toStatusBucket(404, "GET", "/api/kai/analyze/run/active"),
    ).toBe("4xx_expected");
  });

  it("returns 4xx_unexpected for an unexpected client error", () => {
    expect(
      toStatusBucket(400, "POST", "/api/unregistered/path"),
    ).toBe("4xx_unexpected");
  });

  it("buckets 500 as 5xx", () => {
    expect(toStatusBucket(500, "GET", "/api/test")).toBe("5xx");
  });
});

describe("toEventResult", () => {
  it("maps success buckets correctly", () => {
    expect(toEventResult("2xx")).toBe("success");
  });

  it("maps expected client errors correctly", () => {
    expect(toEventResult("4xx_expected")).toBe("expected_error");
  });

  it("maps error buckets correctly", () => {
    expect(toEventResult("5xx")).toBe("error");
  });
});

describe("toDurationBucket", () => {
  it("buckets sub-100ms durations", () => {
    expect(toDurationBucket(50)).toBe("lt_100ms");
  });

  it("buckets 100-300ms durations", () => {
    expect(toDurationBucket(200)).toBe("100ms_300ms");
  });

  it("buckets 300ms-1s durations", () => {
    expect(toDurationBucket(500)).toBe("300ms_1s");
  });

  it("buckets 1s-3s durations", () => {
    expect(toDurationBucket(2000)).toBe("1s_3s");
  });

  it("buckets 3s-10s durations", () => {
    expect(toDurationBucket(5000)).toBe("3s_10s");
  });

  it("buckets 10s+ durations", () => {
    expect(toDurationBucket(10000)).toBe("gte_10s");
  });
});