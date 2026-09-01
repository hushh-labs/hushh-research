import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson, mockGetPermissionState, mockGetCurrentPosition } =
  vi.hoisted(() => ({
    mockApiJson: vi.fn(),
    mockGetPermissionState: vi.fn(),
    mockGetCurrentPosition: vi.fn(),
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
  HushhLocation: {
    getPermissionState: mockGetPermissionState,
    getCurrentPosition: mockGetCurrentPosition,
  },
}));

import { OneLocationService } from "@/lib/one-location/service";

describe("OneLocationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiJson.mockResolvedValue({});
  });

  it("registers recipient public key without private key material", async () => {
    mockApiJson.mockResolvedValueOnce({
      recipientKey: {
        userId: "user_b",
        displayName: "Verified user",
        phoneVerified: true,
        keyId: "key_b",
        keyAlgorithm: "ECDH-P256-AES256-GCM",
        canReceiveLocation: true,
      },
    });

    await OneLocationService.registerRecipientKey({
      vaultOwnerToken: "vault-token",
      keyId: "key_b",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/recipient-keys",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          keyId: "key_b",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
          algorithm: "ECDH-P256-AES256-GCM",
        }),
      },
    );
    expect(mockApiJson.mock.calls[0]?.[1]?.body).not.toContain("private");
  });

  it("reads the focused recipient list for a voice selection", async () => {
    mockApiJson.mockResolvedValueOnce({
      recipients: [{ userId: "user_b", displayName: "Person B" }],
    });

    await expect(OneLocationService.listRecipients("vault-token")).resolves.toEqual([
      { userId: "user_b", displayName: "Person B", isRia: false },
    ]);
    expect(mockApiJson).toHaveBeenCalledWith("/api/one/location/recipients", {
      headers: { Authorization: "Bearer vault-token" },
    });
  });

  it("reads recipient pages without changing the legacy complete-list contract", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [
        {
          userId: "user_51",
          displayName: "Same",
          connectedFromContacts: true,
          isRia: true,
        },
      ],
      page: 2,
      hasMore: true,
      totalCount: 5000,
    });

    const page = await OneLocationService.listRecipientsPage({
      vaultOwnerToken: "vault-token",
      page: 2,
      limit: 50,
      query: "same",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/recipients?page=2&limit=50&query=same",
      { headers: { Authorization: "Bearer vault-token" } },
    );
    expect(page).toMatchObject({ page: 2, hasMore: true, totalCount: 5000 });
    expect(page.items[0]).toMatchObject({
      connectedFromContacts: true,
      isRia: true,
    });
  });

  it("normalizes RIA status on Circle detail member rows", async () => {
    mockApiJson.mockResolvedValueOnce({
      circle: {
        id: "circle-1",
        name: "Family",
        members: [
          { userId: "member-1", displayName: "Ada Advisor", isRia: true },
          { userId: "member-2", displayName: "Pat Person" },
        ],
      },
    });

    const circle = await OneLocationService.getCircle({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
    });

    expect(circle.members.map((member) => member.isRia)).toEqual([true, false]);
  });

  it("uses overview, member pages, eligible pages, and summary-only Trusted reads", async () => {
    mockApiJson
      .mockResolvedValueOnce({ circle: { id: "circle-1", name: "Family" } })
      .mockResolvedValueOnce({
        items: [{ userId: "member-1", displayName: "Member One", isRia: true }],
        page: 2,
        hasMore: true,
        totalCount: 5000,
      })
      .mockResolvedValueOnce({
        eligibleConnections: [],
        pendingInvites: [],
        remainingCapacity: 12,
        page: 2,
        hasMore: true,
        totalCount: 5000,
      })
      .mockResolvedValueOnce({ circle: { id: "trusted", name: "Trusted" } });

    await OneLocationService.getCircleOverview({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
    });
    const membersPage = await OneLocationService.listCircleMembersPage({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
      page: 2,
      limit: 50,
      query: "same",
    });
    await OneLocationService.listNamedCircleEligibleConnectionsPage({
      vaultOwnerToken: "vault-token",
      circleId: "circle-1",
      page: 2,
      limit: 50,
      query: "same",
    });
    await OneLocationService.ensureTrustedSystemCircle({
      vaultOwnerToken: "vault-token",
      summaryOnly: true,
    });

    expect(mockApiJson.mock.calls.map(([path]) => path)).toEqual([
      "/api/one/location/circles/circle-1/overview",
      "/api/one/location/circles/circle-1/members?page=2&limit=50&query=same",
      "/api/one/location/circles/circle-1/eligible-connections?page=2&limit=50&query=same",
      "/api/one/location/circles/trusted?summaryOnly=true",
    ]);
    expect(membersPage.items[0]).toMatchObject({ isRia: true });
  });

  it("stores encrypted envelopes without plaintext coordinates", async () => {
    mockApiJson.mockResolvedValueOnce({ envelope: { id: "env_1" } });

    await OneLocationService.storeEnvelope({
      vaultOwnerToken: "vault-token",
      grantId: "grant_1",
      envelope: {
        algorithm: "ECDH-P256-AES256-GCM",
        recipientKeyId: "key_b",
        ciphertext: "ciphertext",
        iv: "iv",
        senderEphemeralPublicKeyJwk: { kty: "EC" },
        capturedAt: "2026-05-20T00:00:00.000Z",
        sourcePlatform: "web",
        metadata: { plaintext: false },
      },
    });

    const body = String(mockApiJson.mock.calls[0]?.[1]?.body || "");
    expect(mockApiJson.mock.calls[0]?.[0]).toBe(
      "/api/one/location/grants/grant_1/envelopes",
    );
    expect(body).toContain("ciphertext");
    expect(body).not.toContain("latitude");
    expect(body).not.toContain("longitude");
  });

  it("sends one idempotent grant-and-envelope request for private check-in", async () => {
    const envelope = {
      algorithm: "ECDH-P256-AES256-GCM",
      recipientKeyId: "key_b",
      ciphertext: "ciphertext",
      iv: "iv",
      senderEphemeralPublicKeyJwk: { kty: "EC" },
      capturedAt: "2026-07-31T00:00:00.000Z",
      sourcePlatform: "web" as const,
      metadata: { plaintext: false },
    };
    mockApiJson.mockResolvedValueOnce({
      grant: { id: "grant_1" },
      envelope: { id: "envelope_1" },
      idempotentReplay: false,
    });

    await OneLocationService.createGrantWithEnvelope({
      vaultOwnerToken: "vault-token",
      recipientUserId: "user_b",
      recipientKeyId: "key_b",
      durationHours: 1,
      clientOperationId: "123e4567-e89b-12d3-a456-426614174000",
      confirmedAt: "2026-07-31T00:00:01.000Z",
      envelope,
      reason: "Made it safely",
      shareKind: "check_in",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/grants/with-envelope",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipientUserId: "user_b",
          recipientKeyId: "key_b",
          durationHours: 1,
          clientOperationId: "123e4567-e89b-12d3-a456-426614174000",
          confirmedAt: "2026-07-31T00:00:01.000Z",
          envelope,
          reason: "Made it safely",
          shareKind: "check_in",
        }),
      }),
    );
  });

  it("uses authenticated recipient route for viewing envelopes", async () => {
    mockApiJson.mockResolvedValueOnce({ grant: {}, envelope: {} });

    await OneLocationService.viewEnvelope({
      vaultOwnerToken: "vault-token",
      grantId: "grant_1",
    });

    // allow_empty asks the backend to answer "live share, owner hasn't
    // published a point yet" with 200 + a null envelope instead of a 404.
    // Without it that ordinary state is a failed request on every poll.
    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/grants/grant_1/envelope?allow_empty=1",
      {
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
      },
    );
    expect(mockApiJson.mock.calls[0]?.[0]).not.toContain("/api/kai");
    expect(mockApiJson.mock.calls[0]?.[0]).not.toContain("/location/shared");
  });

  it("carries stable operation ids on repeatable duration mutations", async () => {
    mockApiJson
      .mockResolvedValueOnce({ grant: { id: "grant_1" } })
      .mockResolvedValueOnce({ grant: { id: "grant_1" } });

    await OneLocationService.shortenGrant({
      vaultOwnerToken: "vault-token",
      grantId: "grant_1",
      durationHours: 1,
      clientOperationId: "shorten-operation-0001",
    });
    await OneLocationService.setGrantDuration({
      vaultOwnerToken: "vault-token",
      grantId: "grant_1",
      durationHours: 2,
      durationMode: "timed",
      clientOperationId: "duration-operation-0001",
    });

    expect(JSON.parse(String(mockApiJson.mock.calls[0]?.[1]?.body))).toEqual({
      durationHours: 1,
      clientOperationId: "shorten-operation-0001",
    });
    expect(JSON.parse(String(mockApiJson.mock.calls[1]?.[1]?.body))).toEqual({
      durationHours: 2,
      durationMode: "timed",
      clientOperationId: "duration-operation-0001",
    });
  });

  it("keeps the grant id escaped ahead of the allow_empty query", async () => {
    // The grant id is path data and the flag is query data; a grant id that
    // contains a delimiter must not be able to smuggle in extra parameters.
    mockApiJson.mockResolvedValueOnce({ grant: {}, envelope: null });

    await OneLocationService.viewEnvelope({
      vaultOwnerToken: "vault-token",
      grantId: "grant/1?allow_empty=0",
    });

    expect(mockApiJson.mock.calls[0]?.[0]).toBe(
      "/api/one/location/grants/grant%2F1%3Fallow_empty%3D0/envelope?allow_empty=1",
    );
  });

  it("uses the authenticated One request route when asking someone to share", async () => {
    mockApiJson.mockResolvedValueOnce({
      request: {
        id: "request_1",
        ownerUserId: "user_b",
        requesterUserId: "user_a",
        status: "pending",
      },
    });

    await OneLocationService.requestAccess({
      vaultOwnerToken: "vault-token",
      ownerUserId: "user_b",
      message: "Can you share?",
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/location/requests", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ownerUserId: "user_b",
        message: "Can you share?",
      }),
    });
  });

  it("sends the current server-owned rule version for automatic approval", async () => {
    mockApiJson.mockResolvedValueOnce({
      request: { id: "request_1", status: "approved" },
      grant: { id: "grant_1", status: "active" },
    });

    await OneLocationService.approveRequest({
      vaultOwnerToken: "vault-token",
      requestId: "request_1",
      approvalMode: "automatic",
      autoApproveRuleVersion: 7,
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/requests/request_1/approve",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          approvalMode: "automatic",
          autoApproveRuleVersion: 7,
        }),
      },
    );
  });

  it("reads Nearby Check-In preferences from the dedicated endpoint", async () => {
    mockApiJson.mockResolvedValueOnce({
      preferences: {
        visible: true,
        allowConnectionRequests: false,
        updatedAt: null,
      },
    });

    const preferences = await OneLocationService.getNearbyCheckInPreferences(
      "vault-token",
    );

    expect(mockApiJson.mock.calls[0]?.[0]).toBe(
      "/api/one/location/nearby-check-in-preferences",
    );
    expect(preferences).toEqual({
      visible: true,
      allowConnectionRequests: false,
      updatedAt: null,
    });
  });

  it("writes Nearby Check-In preferences to the dedicated endpoint", async () => {
    mockApiJson.mockResolvedValueOnce({
      preferences: {
        visible: false,
        allowConnectionRequests: true,
        updatedAt: "2026-08-26T09:00:00.000Z",
      },
    });

    await OneLocationService.updateNearbyCheckInPreferences({
      vaultOwnerToken: "vault-token",
      visible: false,
      allowConnectionRequests: true,
    });

    const body = JSON.parse(String(mockApiJson.mock.calls[0]?.[1]?.body));
    expect(mockApiJson.mock.calls[0]?.[0]).toBe(
      "/api/one/location/nearby-check-in-preferences",
    );
    expect(mockApiJson.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(body).toEqual({ visible: false, allowConnectionRequests: true });
  });

  it("updates the server-owned all-contacts rule", async () => {
    mockApiJson.mockResolvedValueOnce({
      preference: {
        enabled: true,
        scope: { kind: "all_contacts" },
        enabledAt: "2026-08-24T09:00:00.000Z",
        ruleVersion: 1,
      },
    });

    await OneLocationService.updateAutoApprovePreference({
      vaultOwnerToken: "vault-token",
      enabled: true,
      scope: { kind: "all_contacts" },
    });

    const body = JSON.parse(String(mockApiJson.mock.calls[0]?.[1]?.body));
    expect(mockApiJson.mock.calls[0]?.[0]).toBe(
      "/api/one/location/auto-approve-preference",
    );
    expect(mockApiJson.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(body).toEqual({ enabled: true, scopeKind: "all_contacts" });
  });

  it("updates a Circle rule and can turn the server rule off", async () => {
    const circleId = "550e8400-e29b-41d4-a716-446655440000";
    mockApiJson
      .mockResolvedValueOnce({
        preference: {
          enabled: true,
          scope: { kind: "circle", circleId },
          enabledAt: "2026-08-24T09:00:00.000Z",
          ruleVersion: 2,
        },
      })
      .mockResolvedValueOnce({
        preference: {
          enabled: false,
          scope: null,
          enabledAt: null,
          ruleVersion: 3,
        },
      });

    await OneLocationService.updateAutoApprovePreference({
      vaultOwnerToken: "vault-token",
      enabled: true,
      scope: { kind: "circle", circleId },
    });
    await OneLocationService.updateAutoApprovePreference({
      vaultOwnerToken: "vault-token",
      enabled: false,
    });

    expect(JSON.parse(String(mockApiJson.mock.calls[0]?.[1]?.body))).toEqual({
      enabled: true,
      scopeKind: "circle",
      circleId,
    });
    expect(JSON.parse(String(mockApiJson.mock.calls[1]?.[1]?.body))).toEqual({
      enabled: false,
    });
  });

  it("marks manual approval explicitly and omits standing-rule context", async () => {
    mockApiJson.mockResolvedValueOnce({
      request: { id: "request_1", status: "approved" },
      grant: { id: "grant_1", status: "active" },
    });

    await OneLocationService.approveRequest({
      vaultOwnerToken: "vault-token",
      requestId: "request_1",
      approvalMode: "manual",
      durationHours: 1,
    });

    const body = JSON.parse(String(mockApiJson.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ approvalMode: "manual", durationHours: 1 });
    expect(JSON.stringify(body)).not.toContain("autoApprove");
  });

  it("preserves an invalid automatic rule version so the server can reject it", async () => {
    mockApiJson.mockResolvedValueOnce({
      request: { id: "request_1", status: "pending" },
      grant: { id: "grant_1", status: "inactive" },
    });

    await OneLocationService.approveRequest({
      vaultOwnerToken: "vault-token",
      requestId: "request_1",
      approvalMode: "automatic",
      autoApproveRuleVersion: 0,
    });

    const body = JSON.parse(String(mockApiJson.mock.calls[0]?.[1]?.body));
    expect(body.approvalMode).toBe("automatic");
    expect(body.autoApproveRuleVersion).toBe(0);
  });

  it("creates public location links with an owner-captured snapshot", async () => {
    mockApiJson.mockResolvedValueOnce({
      invite: { id: "invite_1", status: "active" },
      publicToken: "token_1",
      publicUrl: "/one/location/view/token_1",
    });
    const locationSnapshot = {
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 18,
      capturedAt: "2026-05-20T07:30:00.000Z",
      sourcePlatform: "web" as const,
    };

    await OneLocationService.createPublicInvite({
      vaultOwnerToken: "vault-token",
      durationHours: 1,
      locationSnapshot,
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/public-invites",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ durationHours: 1, locationSnapshot }),
      },
    );
  });

  it("resolves public location links with an attached public snapshot", async () => {
    mockApiJson.mockResolvedValueOnce({
      invite: {
        status: "active",
        durationHours: 1,
        expiresAt: "2026-05-20T08:30:00.000Z",
        ownerLabel: "A trusted person",
        locationAvailable: true,
      },
      publicLocation: {
        latitude: 28.6139,
        longitude: 77.209,
        accuracyM: 18,
        capturedAt: "2026-05-20T07:30:00.000Z",
        sourcePlatform: "web",
      },
    });

    const response =
      await OneLocationService.resolvePublicInvite("public-token");

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/public-invites/public-token",
      {},
    );
    expect(response.invite.locationAvailable).toBe(true);
    expect(response.publicLocation?.latitude).toBe(28.6139);
    expect(response.publicLocation?.longitude).toBe(77.209);
  });

  it("submits public invite intake without an auth token and receives public location", async () => {
    mockApiJson.mockResolvedValueOnce({
      submission: { id: "submission_1", status: "approved" },
      publicLocation: {
        latitude: 28.6139,
        longitude: 77.209,
        accuracyM: 18,
        capturedAt: "2026-05-20T07:30:00.000Z",
        sourcePlatform: "web",
      },
      request: null,
    });

    await OneLocationService.submitPublicInviteRequest({
      publicToken: "public-token",
      visitorDisplayName: "Relative",
      phoneNumber: "+917023488012",
      message: "Please share.",
    });

    const [, options] = mockApiJson.mock.calls[0] || [];
    const body = String(options?.body || "");
    expect(mockApiJson.mock.calls[0]?.[0]).toBe(
      "/api/one/location/public-invites/public-token/submit",
    );
    expect(options?.headers).toEqual({ "Content-Type": "application/json" });
    expect(body).toContain("Relative");
    expect(body).not.toContain("latitude");
    expect(body).not.toContain("longitude");
    expect(body).not.toContain("Authorization");
  });

  it("delegates foreground capture to the Capacitor location plugin", async () => {
    mockGetCurrentPosition.mockResolvedValueOnce({
      latitude: 1,
      longitude: 2,
      accuracyM: 3,
      capturedAt: "2026-05-20T00:00:00.000Z",
      sourcePlatform: "web",
    });

    const point = await OneLocationService.captureCurrentPosition();

    expect(point.sourcePlatform).toBe("web");
    expect(mockGetCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
  });
});
