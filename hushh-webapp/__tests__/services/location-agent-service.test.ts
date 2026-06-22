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

  it("uses authenticated recipient route for viewing envelopes", async () => {
    mockApiJson.mockResolvedValueOnce({ grant: {}, envelope: {} });

    await OneLocationService.viewEnvelope({
      vaultOwnerToken: "vault-token",
      grantId: "grant_1",
    });

    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/grants/grant_1/envelope",
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

  it("creates public location links with an owner-captured snapshot", async () => {
    mockApiJson.mockResolvedValueOnce({
      invite: { id: "invite_1", status: "active" },
      publicToken: "token_1",
      publicUrl: "/one/location/request/token_1",
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
