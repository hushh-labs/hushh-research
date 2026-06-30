import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRequestId,
  DEFAULT_MAX_CLOCK_DRIFT_MS,
  FUTURE_TIMESTAMP_ERROR,
  getOrCreateRequestId,
  getOrCreateRequestTimestampMs,
  INVALID_TIMESTAMP_ERROR,
  REQUEST_ID_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  sanitizeRequestId,
  validateHeaderTimestampConstraints,
} from "@/lib/observability/request-id";

describe("request-id utilities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("sanitizeRequestId", () => {
    it("accepts a valid request id", () => {
      expect(sanitizeRequestId("request-id-1234")).toBe("request-id-1234");
    });

    it("trims surrounding whitespace", () => {
      expect(sanitizeRequestId("  request-id-1234  ")).toBe("request-id-1234");
    });

    it("returns null for empty values", () => {
      expect(sanitizeRequestId("")).toBeNull();
      expect(sanitizeRequestId("   ")).toBeNull();
      expect(sanitizeRequestId(null)).toBeNull();
      expect(sanitizeRequestId(undefined)).toBeNull();
    });

    it("rejects invalid characters", () => {
      expect(sanitizeRequestId("bad$request")).toBeNull();
    });

    it("rejects ids that are too short", () => {
      expect(sanitizeRequestId("short")).toBeNull();
    });
  });

  describe("validateHeaderTimestampConstraints", () => {
    const now = 1_000_000;

    it("accepts a valid timestamp", () => {
      expect(
        validateHeaderTimestampConstraints(now, { nowMs: now })
      ).toEqual({
        isSyncBlockAccepted: true,
        errorLabel: null,
      });
    });

    it("rejects future timestamps", () => {
      expect(
        validateHeaderTimestampConstraints(
          now + DEFAULT_MAX_CLOCK_DRIFT_MS + 1,
          { nowMs: now }
        )
      ).toEqual({
        isSyncBlockAccepted: false,
        errorLabel: FUTURE_TIMESTAMP_ERROR,
      });
    });

    it("rejects invalid timestamps", () => {
      expect(
        validateHeaderTimestampConstraints(Number.NaN, { nowMs: now })
      ).toEqual({
        isSyncBlockAccepted: false,
        errorLabel: INVALID_TIMESTAMP_ERROR,
      });
    });
  });

  describe("getOrCreateRequestTimestampMs", () => {
    const now = 5_000;

    it("uses a valid header timestamp", () => {
      const headers = new Headers({
        [REQUEST_TIMESTAMP_HEADER]: "4000",
      });

      expect(getOrCreateRequestTimestampMs(headers, now)).toBe(4000);
    });

    it("falls back when header is missing", () => {
      expect(getOrCreateRequestTimestampMs(undefined, now)).toBe(now);
    });

    it("falls back when header is invalid", () => {
      const headers = new Headers({
        [REQUEST_TIMESTAMP_HEADER]: "abc",
      });

      expect(getOrCreateRequestTimestampMs(headers, now)).toBe(now);
    });

    it("falls back when timestamp is too far in the future", () => {
      const headers = new Headers({
        [REQUEST_TIMESTAMP_HEADER]: String(
          now + DEFAULT_MAX_CLOCK_DRIFT_MS + 10
        ),
      });

      expect(getOrCreateRequestTimestampMs(headers, now)).toBe(now);
    });
  });

  describe("getOrCreateRequestId", () => {
    it("returns a valid request id from headers", () => {
      const headers = new Headers({
        [REQUEST_ID_HEADER]: "request-id-1234",
      });

      expect(getOrCreateRequestId(headers)).toBe("request-id-1234");
    });

    it("creates a new id when header is invalid", () => {
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("generated-id");

      const headers = new Headers({
        [REQUEST_ID_HEADER]: "bad$id",
      });

      expect(getOrCreateRequestId(headers)).toBe("generated-id");
    });

    it("creates a new id when header is missing", () => {
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("generated-id");

      expect(getOrCreateRequestId(undefined)).toBe("generated-id");
    });
  });

  describe("createRequestId", () => {
    it("uses crypto.randomUUID when available", () => {
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("uuid-value");

      expect(createRequestId()).toBe("uuid-value");
    });

    it("falls back when randomUUID is unavailable", () => {
      const original = globalThis.crypto.randomUUID;

      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: undefined,
        configurable: true,
      });

      const id = createRequestId();

      expect(id.startsWith("req_")).toBe(true);

      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    });
  });
});
