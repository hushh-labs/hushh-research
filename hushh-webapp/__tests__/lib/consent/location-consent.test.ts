import { describe, expect, it } from "vitest";

import {
  isCircleMemberInviteConsent,
  isLocationConsent,
  locationConsentSummary,
  locationConsentWorkflowHref,
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

  it("recognizes targeted Circle membership invitations", () => {
    const metadata = {
      request_source: "one_location_circle_member_invite",
      invite_id: "invite_1",
      circle_name: "Hushh Family",
      requester_label: "Bob",
      section: "people",
    };

    expect(isCircleMemberInviteConsent(metadata)).toBe(true);
    expect(locationConsentSummary(metadata)).toContain(
      "Bob invited you to join Hushh Family",
    );
    expect(locationConsentWorkflowHref(metadata)).toBe(
      "/one/location?circleInviteId=invite_1&section=people",
    );
  });
});

describe("locationConsentSummary direction", () => {
  // Regression guard: a share grant appears in the Consent Center Active tab
  // from both sides at once (owner side: "people who can see me"; recipient
  // side: "shared with me"), both carrying the same counterpart name and the
  // same generic scope_description ("Live location sharing"). Without
  // branching on metadata.section the two rows were indistinguishable, so a
  // user reviewing consent could not tell whose location was exposed to
  // whom. See OneLocationCenterContributor._active_grants (backend) for
  // where "people" vs "shared" is set.
  it("describes a plain share from the owner's side as sharing out", () => {
    const summary = locationConsentSummary({
      request_source: "one_location_share_grant",
      section: "people",
      share_kind: "share",
      requester_label: "Jhumma",
    });
    expect(summary).toBe("You're sharing your location with Jhumma.");
  });

  it("describes the same plain share from the recipient's side as sharing in", () => {
    const summary = locationConsentSummary({
      request_source: "one_location_share_grant",
      section: "shared",
      share_kind: "share",
      requester_label: "Jhumma",
    });
    expect(summary).toBe("Jhumma is sharing their location with you.");
  });

  it("keeps the two directions distinguishable for the same counterpart", () => {
    const base = {
      request_source: "one_location_share_grant",
      share_kind: "share",
      requester_label: "Jhumma",
    };
    const ownerSide = locationConsentSummary({ ...base, section: "people" });
    const recipientSide = locationConsentSummary({
      ...base,
      section: "shared",
    });
    expect(ownerSide).not.toBe(recipientSide);
  });

  it("describes a Check-In from the owner's side as sharing out", () => {
    const summary = locationConsentSummary({
      request_source: "one_location_share_grant",
      section: "people",
      share_kind: "check_in",
      requester_label: "Jhumma",
      duration_label: "1 hour",
    });
    expect(summary).toBe(
      "You checked in and shared your location with Jhumma for 1 hour.",
    );
  });

  it("describes an SOS share from the owner's side as sharing out", () => {
    const summary = locationConsentSummary({
      request_source: "one_location_share_grant",
      section: "people",
      share_kind: "sos",
      requester_label: "Jhumma",
    });
    expect(summary).toBe(
      "You're sharing your live location with Jhumma.",
    );
  });

  it("does not treat a pending access request as owner-side (no share_kind)", () => {
    const summary = locationConsentSummary({
      request_source: "one_location_access_request",
      section: "approvals",
      requester_label: "Jhumma",
    });
    expect(summary).toBe("Jhumma wants to see your location through Location.");
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

  it("maps a targeted Circle member invite without treating it as access", () => {
    const ref = parseLocationConsentEntry({
      id: "one_location_circle_member_invite:invite_1",
      request_id: "invite_1",
      metadata: {
        request_source: "one_location_circle_member_invite",
        invite_id: "invite_1",
      },
    });
    expect(ref).toEqual({
      kind: "circle_member_invite",
      id: "invite_1",
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
