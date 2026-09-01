import { describe, expect, it } from "vitest";

import {
  isLocationRequestExpired,
  isLocationRequestPending,
  locationRequestExpiryMs,
} from "@/lib/one-location/request-expiry";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";

const REQUESTED_AT = "2026-09-01T08:00:00.000Z";
const REQUESTED_AT_MS = Date.parse(REQUESTED_AT);

function request(
  overrides: Partial<OneLocationAccessRequest> = {},
): OneLocationAccessRequest {
  return {
    id: "request_1",
    ownerUserId: "owner",
    requesterUserId: "requester",
    status: "pending",
    requestedAt: REQUESTED_AT,
    ...overrides,
  };
}

describe("One Location request expiry", () => {
  it("does not invent a deadline when an older API omitted one", () => {
    const omitted = request();

    expect(locationRequestExpiryMs(omitted)).toBeNull();
    expect(
      isLocationRequestPending(omitted, REQUESTED_AT_MS + 30 * 24 * 3_600_000),
    ).toBe(true);
  });

  it("uses the server deadline when one is present", () => {
    const serverDeadline = REQUESTED_AT_MS + 3_600_000;
    const withDeadline = request({
      expiresAt: new Date(serverDeadline).toISOString(),
    });

    expect(locationRequestExpiryMs(withDeadline)).toBe(serverDeadline);
    expect(isLocationRequestExpired(withDeadline, serverDeadline)).toBe(true);
  });

  it("does not invent a deadline for null or malformed server values", () => {
    const linked = request({ expiresAt: null });
    const malformed = request({ expiresAt: "not-a-timestamp" });

    expect(locationRequestExpiryMs(linked)).toBeNull();
    expect(locationRequestExpiryMs(malformed)).toBeNull();
    expect(
      isLocationRequestPending(linked, REQUESTED_AT_MS + 30 * 24 * 3_600_000),
    ).toBe(true);
    expect(
      isLocationRequestPending(
        malformed,
        REQUESTED_AT_MS + 30 * 24 * 3_600_000,
      ),
    ).toBe(true);
  });

  it("trusts an explicit terminal status even when no timestamp is available", () => {
    expect(
      isLocationRequestExpired(
        request({ status: "expired", requestedAt: null, expiresAt: null }),
        REQUESTED_AT_MS,
      ),
    ).toBe(true);
  });
});
