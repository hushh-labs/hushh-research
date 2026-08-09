import { describe, expect, it } from "vitest";

import {
  isActiveSmsEmergencyGrant,
  isIncomingLocationRequestActionable,
} from "@/lib/feed/use-feed-actionables";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
} from "@/lib/one-location/types";

const ME = "user-me";
const CONTACT = "user-contact";

function request(
  overrides: Partial<OneLocationAccessRequest>,
): OneLocationAccessRequest {
  return {
    id: "req-1",
    ownerUserId: CONTACT,
    requesterUserId: ME,
    status: "pending",
    ...overrides,
  };
}

describe("isIncomingLocationRequestActionable", () => {
  it("does NOT surface a request the viewer sent (outgoing) — the reported self-card bug", () => {
    // Viewer asked to see CONTACT's location: owner=contact, requester=me.
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: CONTACT, requesterUserId: ME }),
        ME,
      ),
    ).toBe(false);
  });

  it("surfaces a genuine incoming request the viewer owns", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: ME, requesterUserId: CONTACT }),
        ME,
      ),
    ).toBe(true);
  });

  it("does NOT surface a self-request where sender equals recipient", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: ME, requesterUserId: ME }),
        ME,
      ),
    ).toBe(false);
  });

  it("does NOT surface a non-pending incoming request", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({
          ownerUserId: ME,
          requesterUserId: CONTACT,
          status: "approved",
        }),
        ME,
      ),
    ).toBe(false);
  });

  it("does NOT surface a pending request owned by someone else", () => {
    expect(
      isIncomingLocationRequestActionable(
        request({ ownerUserId: "user-other", requesterUserId: CONTACT }),
        ME,
      ),
    ).toBe(false);
  });
});

function grant(overrides: Partial<OneLocationGrant>): OneLocationGrant {
  return {
    id: "grant-1",
    ownerUserId: CONTACT,
    recipientUserId: ME,
    recipientKeyId: "key-1",
    status: "active",
    consentScope: "cap.location.live",
    capabilityScopes: ["cap.location.live"],
    durationHours: 1,
    shareKind: "sos",
    ...overrides,
  };
}

describe("isActiveSmsEmergencyGrant", () => {
  it("surfaces a live SOS share as an emergency alert", () => {
    expect(isActiveSmsEmergencyGrant(grant({ shareKind: "sos" }))).toBe(true);
  });

  it("does NOT surface a plain (non-SOS) share", () => {
    expect(isActiveSmsEmergencyGrant(grant({ shareKind: "share" }))).toBe(false);
  });

  it("does NOT surface a friendly check-in", () => {
    expect(isActiveSmsEmergencyGrant(grant({ shareKind: "check_in" }))).toBe(
      false,
    );
  });

  it("does NOT surface an expired or revoked SOS share", () => {
    expect(
      isActiveSmsEmergencyGrant(grant({ shareKind: "sos", status: "expired" })),
    ).toBe(false);
    expect(
      isActiveSmsEmergencyGrant(grant({ shareKind: "sos", status: "revoked" })),
    ).toBe(false);
  });
});
