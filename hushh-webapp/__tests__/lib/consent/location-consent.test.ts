import { describe, expect, it } from "vitest";

import {
  isLocationConsent,
  parseLocationConsentEntry,
} from "@/lib/consent/location-consent";

describe("isLocationConsent", () => {
  it("recognizes One Location request-source metadata", () => {
    expect(
      isLocationConsent({ request_source: "one_location_access_request" }),
    ).toBe(true);
    expect(
      isLocationConsent({ request_source: "one_location_share_grant" }),
    ).toBe(true);
  });

  it("recognizes location-family scopes", () => {
    expect(isLocationConsent(null, "cap.location.live.view")).toBe(true);
    expect(isLocationConsent(null, "attr.location.home")).toBe(true);
  });

  it("ignores unrelated developer consents", () => {
    expect(
      isLocationConsent(
        { request_source: "developer_api_v1" },
        "attr.shopping.receipts.*",
      ),
    ).toBe(false);
  });
});

describe("parseLocationConsentEntry", () => {
  it("maps an access request entry to the request kind + id", () => {
    const ref = parseLocationConsentEntry({
      id: "one_location_request:req_123",
      request_id: "req_123",
      metadata: { request_source: "one_location_access_request" },
    });
    expect(ref).toEqual({
      kind: "access_request",
      id: "req_123",
      requestId: "req_123",
    });
  });

  it("maps a share grant entry to the grant kind + id (no requestId)", () => {
    const ref = parseLocationConsentEntry({
      id: "one_location_grant:grant_456",
      metadata: {
        request_source: "one_location_share_grant",
        grant_id: "grant_456",
      },
    });
    expect(ref).toEqual({
      kind: "share_grant",
      id: "grant_456",
      requestId: null,
    });
  });

  it("maps a public invite entry to the public_invite kind", () => {
    const ref = parseLocationConsentEntry({
      id: "one_location_public:pi_789",
      metadata: { request_source: "one_location_public_invite" },
    });
    expect(ref).toEqual({
      kind: "public_invite",
      id: "pi_789",
      requestId: null,
    });
  });

  it("maps a circle invite entry to the circle_invite kind", () => {
    const ref = parseLocationConsentEntry({
      id: "one_location_circle:ci_321",
      metadata: { request_source: "one_location_circle_invite" },
    });
    expect(ref).toEqual({
      kind: "circle_invite",
      id: "ci_321",
      requestId: null,
    });
  });

  it("falls back to request_source when the id prefix is missing", () => {
    const ref = parseLocationConsentEntry({
      id: "req_999",
      request_id: "req_999",
      metadata: { request_source: "one_location_access_request" },
    });
    expect(ref.kind).toBe("access_request");
    expect(ref.requestId).toBe("req_999");
  });

  it("recovers the grant id from metadata when the suffix is absent", () => {
    const ref = parseLocationConsentEntry({
      id: "one_location_grant:",
      metadata: {
        request_source: "one_location_share_grant",
        grant_id: "grant_from_meta",
      },
    });
    expect(ref).toEqual({
      kind: "share_grant",
      id: "grant_from_meta",
      requestId: null,
    });
  });

  it("returns unknown for non-location entries", () => {
    const ref = parseLocationConsentEntry({
      id: "identifier:macy",
      metadata: { request_source: "developer_api_v1" },
    });
    expect(ref.kind).toBe("unknown");
    expect(ref.requestId).toBeNull();
  });
});
