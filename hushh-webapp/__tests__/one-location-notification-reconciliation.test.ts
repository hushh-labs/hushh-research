import { describe, expect, it } from "vitest";

import { buildOneLocationNotificationPayloads } from "@/lib/one-location/notification-reconciliation";
import type { OneLocationState } from "@/lib/one-location/types";

const USER_ID = "user-me";

function stateFixture(): OneLocationState {
  return {
    recipients: [
      {
        userId: "owner-1",
        displayName: "Alex",
        phoneVerified: true,
        keyAlgorithm: "ECDH-P256",
        canReceiveLocation: true,
      },
      {
        userId: "requester-1",
        displayName: "Sam",
        phoneVerified: true,
        keyAlgorithm: "ECDH-P256",
        canReceiveLocation: true,
      },
    ],
    ownerGrants: [],
    receivedGrants: [
      {
        id: "grant-approved",
        ownerUserId: "owner-1",
        recipientUserId: USER_ID,
        ownerDisplayName: "Alex",
        recipientKeyId: "key-1",
        status: "active",
        consentScope: "one.location",
        capabilityScopes: [],
        durationHours: 2,
        shareKind: "check_in",
        shareMessage: "Reached safely",
      },
      {
        id: "grant-direct",
        ownerUserId: "requester-1",
        recipientUserId: USER_ID,
        ownerDisplayName: "Sam",
        recipientKeyId: "key-1",
        status: "active",
        consentScope: "one.location",
        capabilityScopes: [],
        durationHours: 1,
        shareKind: "check_in",
        shareMessage: "Reached safely",
      },
    ],
    requests: [
      {
        id: "request-incoming",
        ownerUserId: USER_ID,
        requesterUserId: "requester-1",
        requesterDisplayName: "Sam",
        status: "pending",
      },
      {
        id: "request-approved",
        ownerUserId: "owner-1",
        requesterUserId: USER_ID,
        status: "approved",
        approvedGrantId: "grant-approved",
      },
      {
        id: "request-denied",
        ownerUserId: "owner-1",
        requesterUserId: USER_ID,
        status: "denied",
      },
    ],
    referrals: [
      {
        id: "referral-1",
        grantId: "grant-source",
        ownerUserId: "owner-1",
        referringUserId: "requester-1",
        referredUserId: USER_ID,
        requestId: "request-referral",
        status: "pending",
      },
    ],
    publicInvites: [],
    networkConnections: [
      {
        id: "connection-1",
        userAId: USER_ID,
        userBId: "owner-1",
        inviterUserId: USER_ID,
        inviteeUserId: "owner-1",
        status: "active",
      },
    ],
    publicInviteSubmissions: [
      {
        id: "submission-1",
        inviteId: "invite-1",
        ownerUserId: USER_ID,
        visitorDisplayName: "Taylor",
        status: "matched_request_pending",
      },
    ],
    capabilityScopes: [],
  };
}

describe("One Location global notification reconciliation", () => {
  it("waits for the first encrypted envelope before surfacing SMS", () => {
    const state = stateFixture();
    state.receivedGrants = [
      {
        ...state.receivedGrants[0],
        id: "sms-pending-envelope",
        shareKind: "sos",
        shareMessage: "Come get me",
        latestEnvelopeId: null,
      },
    ];

    expect(
      buildOneLocationNotificationPayloads(state, USER_ID).filter(
        (payload) => payload.type === "location_share_created",
      ),
    ).toEqual([]);

    state.receivedGrants[0]!.latestEnvelopeId = "envelope-1";
    expect(
      buildOneLocationNotificationPayloads(state, USER_ID).filter(
        (payload) => payload.type === "location_share_created",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "location_share_created",
        grant_id: "sms-pending-envelope",
        share_kind: "sos",
        share_message: "Come get me",
      }),
    ]);
  });

  it("reconstructs every user-facing workflow without visiting the Location page", () => {
    const payloads = buildOneLocationNotificationPayloads(stateFixture(), USER_ID);
    expect(payloads.map((payload) => payload.type)).toEqual(
      expect.arrayContaining([
        "location_share_created",
        "location_access_request",
        "location_access_approved",
        "location_access_denied",
        "location_referral_invite",
        "location_public_invite_submitted",
        "location_one_network_joined",
      ]),
    );
    expect(
      payloads.find((payload) => payload.type === "location_share_created"),
    ).toMatchObject({
      grant_id: "grant-direct",
      owner_display_label: "Sam",
      share_kind: "check_in",
      share_message: "Reached safely",
    });
    expect(
      payloads.find((payload) => payload.type === "location_one_network_joined"),
    ).toMatchObject({
      connection_id: "connection-1",
      network_display_label: "Alex",
    });
    expect(
      payloads.find((payload) => payload.type === "location_access_approved"),
    ).toMatchObject({
      request_id: "request-approved",
      grant_id: "grant-approved",
    });
    expect(
      payloads.some(
        (payload) =>
          payload.type === "location_share_created" &&
          payload.grant_id === "grant-approved",
      ),
    ).toBe(false);
  });

  it("suppresses unwatched shares and false terminal events superseded by an active share", () => {
    const state = stateFixture();
    state.receivedGrants.push(
      {
        ...state.receivedGrants[0],
        id: "grant-old-revoked",
        status: "revoked",
      },
      {
        ...state.receivedGrants[0],
        id: "grant-other-expired",
        ownerUserId: "owner-2",
        ownerDisplayName: "Jordan",
        status: "expired",
      },
    );

    const payloads = buildOneLocationNotificationPayloads(state, USER_ID, {
      isGrantUnwatched: (grantId) => grantId === "grant-direct",
    });

    expect(
      payloads.some(
        (payload) =>
          payload.type === "location_share_created" &&
          payload.grant_id === "grant-direct",
      ),
    ).toBe(false);
    expect(payloads.some((payload) => payload.grant_id === "grant-old-revoked")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "location_share_expired",
        grant_id: "grant-other-expired",
      }),
    );
  });
});
