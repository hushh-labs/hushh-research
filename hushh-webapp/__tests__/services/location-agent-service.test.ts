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

  it("creates public request links without sending location coordinates", async () => {
    mockApiJson.mockResolvedValueOnce({
      invite: { id: "invite_1", status: "active" },
      publicToken: "token_1",
      publicUrl: "/one/location/request/token_1",
    });

    await OneLocationService.createPublicInvite({
      vaultOwnerToken: "vault-token",
      durationHours: 1,
    });

    const body = String(mockApiJson.mock.calls[0]?.[1]?.body || "");
    expect(mockApiJson).toHaveBeenCalledWith(
      "/api/one/location/public-invites",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer vault-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ durationHours: 1 }),
      },
    );
    expect(body).not.toContain("latitude");
    expect(body).not.toContain("longitude");
  });

  it("submits public invite requests without an auth token or coordinates", async () => {
    mockApiJson.mockResolvedValueOnce({
      submission: { id: "submission_1", status: "pending_identity" },
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
