import { describe, expect, it } from "vitest";

import { locationWorkflowNotificationCopy } from "@/lib/one-location/notifications";
import { buildOneLocationNotificationPayloads } from "@/lib/one-location/notification-reconciliation";
import type { OneLocationState } from "@/lib/one-location/types";

/**
 * What the popup says about extra time, on both sides.
 *
 * The owner's notification used to read "Someone is asking to view your
 * location" whether the person wanted fifteen minutes or another day, and the
 * approval that answered it read "approved" without ever telling the person who
 * asked which number they got. Both are decisions with a quantity in them, and
 * the quantity was the one thing neither line carried.
 */

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

describe("the owner's popup", () => {
  it("names the extra time and the baseline it is added to", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_access_request",
      requesterLabel: "Ankit Kumar Singh",
      requestedDurationHours: 3,
      requestedDurationMode: "timed",
      isExtension: true,
      extendsGrantExpiresAt: new Date(NOW + 45 * 60_000).toISOString(),
      nowMs: NOW,
    });
    // The title separates the two questions at a glance, before the body is
    // even read -- extra time on a running share is not a fresh ask.
    expect(copy.title).toBe("More location time requested");
    expect(copy.description).toBe(
      "Ankit Kumar Singh is asking for 3 hours more of your live location. They have 45 more min left.",
    );
  });

  it("names the duration on a fresh ask too", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_access_request",
      requesterLabel: "Ankit Kumar Singh",
      requestedDurationHours: 3,
      requestedDurationMode: "timed",
      nowMs: NOW,
    });
    expect(copy.title).toBe("Location request");
    expect(copy.description).toBe(
      "Ankit Kumar Singh is asking to view your location for 3 hours.",
    );
  });

  it("keeps the old sentence when the ask carried no amount", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_access_request",
      requesterLabel: "Ankit Kumar Singh",
      nowMs: NOW,
    });
    expect(copy.description).toBe(
      "Ankit Kumar Singh is asking to view your location.",
    );
  });
});

describe("the requester's popup", () => {
  it("says how much time they were actually given", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_access_approved",
      ownerLabel: "Neelesh Meena",
      isExtension: true,
      grantedDurationHours: 4,
      grantedDurationMode: "timed",
      nowMs: NOW,
    });
    expect(copy.title).toBe("More location time approved");
    expect(copy.description).toBe(
      "Neelesh Meena gave you 4 hours more of their live location.",
    );
  });

  it("names the amount on a plain approval as well", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_access_approved",
      ownerLabel: "Neelesh Meena",
      grantedDurationHours: 1,
      grantedDurationMode: "timed",
      nowMs: NOW,
    });
    expect(copy.description).toBe(
      "Neelesh Meena shared their live location with you 1 hour.",
    );
  });

  it("says a refused extension leaves current access alone", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_access_denied",
      ownerLabel: "Neelesh Meena",
      isExtension: true,
      nowMs: NOW,
    });
    // "Denied" on its own reads as if everything stopped, which is the opposite
    // of what happened -- the time they already hold is still running.
    expect(copy.title).toBe("Extra time declined");
    expect(copy.description).toBe(
      "Neelesh Meena declined the extra time. Any access you already have is unchanged.",
    );
  });
});

function state(overrides: Partial<OneLocationState> = {}): OneLocationState {
  return {
    recipients: [],
    receivedGrants: [],
    requests: [],
    referrals: [],
    ...overrides,
  } as unknown as OneLocationState;
}

describe("the in-app path that never touches FCM", () => {
  it("carries the ask onto the owner's reconciled payload", () => {
    const [payload] = buildOneLocationNotificationPayloads(
      state({
        requests: [
          {
            id: "req_1",
            ownerUserId: "user_a",
            requesterUserId: "user_b",
            requesterDisplayName: "Ankit",
            status: "pending",
            requestedDurationHours: 3,
            requestedDurationMode: "timed",
            extendsGrantId: "grant_1",
            isExtension: true,
            extendsGrantExpiresAt: new Date(NOW + 45 * 60_000).toISOString(),
            requestRevision: 2,
          },
        ],
      }),
      "user_a",
    );

    expect(payload.type).toBe("location_access_request");
    expect(payload.requested_duration_hours).toBe("3");
    expect(payload.is_extension).toBe("true");
    expect(payload.extends_grant_id).toBe("grant_1");
    // A raised ask is a NEW event on the same row. Without the revision the
    // provider's (type, id) de-dup would swallow it and the owner would be left
    // approving the first number, never told it had moved.
    expect(payload.notification_revision).toBe("2");
  });

  it("omits the revision on a first ask, so nothing changes for one", () => {
    const [payload] = buildOneLocationNotificationPayloads(
      state({
        requests: [
          {
            id: "req_1",
            ownerUserId: "user_a",
            requesterUserId: "user_b",
            status: "pending",
            requestedDurationHours: 1,
            requestedDurationMode: "timed",
            requestRevision: 1,
          },
        ],
      }),
      "user_a",
    );
    expect(payload.notification_revision).toBeUndefined();
  });

  it("tells the requester what was granted, read off the grant itself", () => {
    const payloads = buildOneLocationNotificationPayloads(
      state({
        receivedGrants: [
          {
            id: "grant_2",
            ownerUserId: "user_a",
            recipientUserId: "user_b",
            status: "active",
            durationHours: 4,
            durationMode: "timed",
            expiresAt: new Date(NOW + 4 * 3_600_000).toISOString(),
          },
        ],
        requests: [
          {
            id: "req_1",
            ownerUserId: "user_a",
            requesterUserId: "user_b",
            status: "approved",
            approvedGrantId: "grant_2",
            requestedDurationHours: 4,
            requestedDurationMode: "timed",
            extendsGrantId: "grant_1",
            isExtension: true,
          },
        ],
      } as Partial<OneLocationState>),
      "user_b",
    );

    const approved = payloads.find(
      (payload) => payload.type === "location_access_approved",
    );
    // The GRANTED amount, not the requested one: an owner is free to give less
    // than was asked, and the grant is the only number that is true.
    expect(approved?.duration_hours).toBe("4");
    expect(approved?.is_extension).toBe("true");
  });
});
