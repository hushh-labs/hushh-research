import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson } = vi.hoisted(() => ({
  mockApiJson: vi.fn(),
}));

vi.mock("@/lib/services/api-client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly payload?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  apiJson: mockApiJson,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {},
}));

import { OneLocationService } from "@/lib/one-location/service";

describe("OneLocationService Circle member invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiJson.mockResolvedValue({});
  });

  it("loads eligible direct connections and outgoing pending invitations", async () => {
    mockApiJson.mockResolvedValueOnce({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "friend-1",
          displayName: "Asha",
          photoUrl: null,
          connectedAt: "2026-07-24T00:00:00Z",
          isRia: true,
        },
        {
          connectionId: "connection-2",
          userId: "friend-2",
          displayName: "Neel",
          photoUrl: null,
        },
      ],
      pendingInvites: [],
      remainingCapacity: 3,
    });

    const result =
      await OneLocationService.listNamedCircleEligibleConnections({
        vaultOwnerToken: "vault-token",
        circleId: "circle-1",
      });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/circles/circle-1/eligible-connections",
      { headers: { Authorization: "Bearer vault-token" } },
    );
    expect(result.eligibleConnections[0]?.userId).toBe("friend-1");
    expect(result.eligibleConnections[0]?.isRia).toBe(true);
    expect(result.eligibleConnections[1]?.isRia).toBe(false);
    expect(result.remainingCapacity).toBe(3);
  });

  it("sends one batch invitation request for the selected connections", async () => {
    mockApiJson.mockResolvedValueOnce({ invites: [] });

    await OneLocationService.createNamedCircleMemberInvites({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
      inviteeUserIds: ["friend-1", "friend-2"],
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/circle-member-invites",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          circleId: "circle-1",
          inviteeUserIds: ["friend-1", "friend-2"],
        }),
      }),
    );
  });

  it("loads only incoming pending invitations for the People hub", async () => {
    mockApiJson.mockResolvedValueOnce({ invites: [] });

    await OneLocationService.listNamedCircleMemberInvites({
      vaultOwnerToken: "vault-token",
      direction: "incoming",
      status: "pending",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/circle-member-invites?direction=incoming&status=pending",
      { headers: { Authorization: "Bearer vault-token" } },
    );
  });

  it("uses explicit accept, decline and owner-cancel endpoints", async () => {
    mockApiJson
      .mockResolvedValueOnce({
        circle: {
          id: "circle-1",
          name: "Family",
          kind: "family",
          role: "member",
          memberCount: 2,
          memberLimit: 20,
          members: [],
        },
      })
      .mockResolvedValueOnce({ invite: { id: "invite-2" } })
      .mockResolvedValueOnce({ cancelled: true });

    await OneLocationService.acceptNamedCircleMemberInvite({
      vaultOwnerToken: "vault-token",
      inviteId: "invite-1",
    });
    await OneLocationService.declineNamedCircleMemberInvite({
      vaultOwnerToken: "vault-token",
      inviteId: "invite-2",
    });
    await OneLocationService.cancelNamedCircleMemberInvite({
      vaultOwnerToken: "vault-token",
      inviteId: "invite-3",
    });

    expect(mockApiJson.mock.calls.map(([path]) => path)).toEqual([
      "/api/one/location/circle-member-invites/invite-1/accept",
      "/api/one/location/circle-member-invites/invite-2/decline",
      "/api/one/location/circle-member-invites/invite-3",
    ]);
  });
  it("reports who actually went into the Circle", async () => {
    // The route is called circle-member-invites and returns `invites: []`
    // unconditionally -- it adds outright now, and names the people it added in
    // `added`. Reading only `invites` meant this returned an empty array from a
    // call that had just added two people.
    mockApiJson.mockResolvedValueOnce({
      invites: [],
      added: ["friend-1", "friend-2"],
    });

    const added = await OneLocationService.createNamedCircleMemberInvites({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
      inviteeUserIds: ["friend-1", "friend-2"],
    });

    expect(added).toEqual(["friend-1", "friend-2"]);
  });

  it("still answers a server that predates the added array", async () => {
    // A native build can outlive a backend deploy in either direction.
    mockApiJson.mockResolvedValueOnce({
      invites: [{ id: "invite-1", inviteeUserId: "friend-1" }],
    });

    const added = await OneLocationService.createNamedCircleMemberInvites({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
      inviteeUserIds: ["friend-1"],
    });

    expect(added).toEqual(["friend-1"]);
  });

});
