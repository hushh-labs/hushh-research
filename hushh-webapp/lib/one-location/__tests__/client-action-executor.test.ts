import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    captureCurrentPosition: vi.fn(),
    getState: vi.fn(),
    getPermissionState: vi.fn(),
    createGrantWithEnvelope: vi.fn(),
    approveRequest: vi.fn(),
    storeEnvelope: vi.fn(),
    revokeGrant: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(),
}));

import {
  executePrivateLocationAction,
  PrivateLocationActionError,
} from "@/lib/one-location/client-action-executor";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import {
  forgetOneLocationControlPreference,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { pendingLocationRevocationStorageKey } from "@/lib/one-location/location-revocation-queue";
import { OneLocationService } from "@/lib/one-location/service";
import type { ClientAction } from "@/lib/one-location/types";

const userId = "owner-1";
const vaultOwnerToken = "vault-token";
const point = {
  latitude: 25.213815,
  longitude: 75.864752,
  accuracyM: 12,
  capturedAt: "2026-08-01T10:00:00.000Z",
  sourcePlatform: "web" as const,
};
const recipient = {
  userId: "recipient-1",
  displayName: "Mom",
  phoneVerified: true,
  keyId: "recipient-key-1",
  publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  keyAlgorithm: "ECDH-P256",
  canReceiveLocation: true,
};
const envelope = {
  id: "envelope-1",
  recipientKeyId: "recipient-key-1",
  algorithm: "ECDH-P256-AES256-GCM" as const,
  ciphertext: "ciphertext",
  iv: "initialization-vector",
  senderEphemeralPublicKeyJwk: {
    kty: "EC",
    crv: "P-256",
    x: "x",
    y: "y",
  },
  capturedAt: point.capturedAt,
  sourcePlatform: "web" as const,
  metadata: {
    locationMode: "approximate",
    approximateRadiusM: 1_000,
  },
};

function newShareAction(
  locationMode: "approximate" | "precise" = "approximate",
): ClientAction {
  return {
    id: "action-1",
    type: "publish_share",
    summary: "Share with Mom",
    shares: [
      {
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId,
        label: recipient.displayName,
        durationHours: locationMode === "approximate" ? 4 : 1,
        reason: "Meet me",
        locationMode,
      },
    ],
  };
}

describe("executePrivateLocationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetOneLocationControlPreference(userId);
    window.localStorage.removeItem(
      pendingLocationRevocationStorageKey(userId),
    );
    vi.mocked(OneLocationService.captureCurrentPosition).mockResolvedValue(
      point,
    );
    vi.mocked(OneLocationService.getPermissionState).mockResolvedValue({
      state: "granted",
      precise: true,
    } as never);
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [recipient],
      ownerGrants: [],
      requests: [],
    } as never);
    vi.mocked(encryptLocationForRecipient).mockResolvedValue(envelope);
    vi.mocked(OneLocationService.revokeGrant).mockResolvedValue({} as never);
  });

  it("coarsens and encrypts an Area update before atomically creating its grant", async () => {
    vi.mocked(OneLocationService.createGrantWithEnvelope).mockResolvedValue({
      grant: {
        id: "grant-1",
        status: "active",
        latestEnvelopeId: envelope.id,
        locationMode: "approximate",
        approximateRadiusM: 1_000,
      },
      envelope,
      idempotentReplay: false,
    } as never);

    await expect(
      executePrivateLocationAction({
        action: newShareAction(),
        vaultOwnerToken,
        userId,
      }),
    ).resolves.toEqual({ successfulCount: 1, totalCount: 1 });

    expect(encryptLocationForRecipient).toHaveBeenCalledWith({
      point: expect.objectContaining({
        locationMode: "approximate",
        approximateRadiusM: 1_000,
      }),
      recipientPublicKeyJwk: recipient.publicKeyJwk,
      recipientKeyId: recipient.keyId,
    });
    expect(OneLocationService.createGrantWithEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken,
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId,
        durationHours: 4,
        clientOperationId: "location-action:action-1:recipient-1",
        envelope,
        locationMode: "approximate",
        approximateRadiusM: 1_000,
      }),
    );
    expect(OneLocationService.storeEnvelope).not.toHaveBeenCalled();
  });

  it("atomically approves a pending request with the requester's server key", async () => {
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [],
      ownerGrants: [],
      requests: [
        {
          id: "request-1",
          status: "pending",
          requesterUserId: recipient.userId,
          requesterKeyId: recipient.keyId,
          requesterPublicKeyJwk: recipient.publicKeyJwk,
        },
      ],
    } as never);
    vi.mocked(OneLocationService.approveRequest).mockResolvedValue({
      request: {
        id: "request-1",
        status: "approved",
        approvedGrantId: "grant-approval-1",
      },
      grant: {
        id: "grant-approval-1",
        status: "active",
        latestEnvelopeId: "envelope-1",
        locationMode: "precise",
        approximateRadiusM: null,
      },
      envelope,
      idempotentReplay: false,
    } as never);
    const action: ClientAction = {
      id: "approval-action",
      type: "publish_share",
      summary: "Approve Mom",
      shares: [
        {
          recipientUserId: recipient.userId,
          approvalRequestId: "request-1",
          label: recipient.displayName,
          durationHours: 1,
          locationMode: "precise",
        },
      ],
    };

    await executePrivateLocationAction({ action, vaultOwnerToken, userId });

    expect(OneLocationService.approveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        recipientKeyId: recipient.keyId,
        clientOperationId: "location-action:approval-action:request-1",
        locationMode: "precise",
        approximateRadiusM: null,
        envelope,
      }),
    );
    expect(OneLocationService.createGrantWithEnvelope).not.toHaveBeenCalled();
  });

  it("revokes and fails closed when the server changes the reviewed privacy mode", async () => {
    vi.mocked(OneLocationService.createGrantWithEnvelope).mockResolvedValue({
      grant: {
        id: "grant-mismatch",
        status: "active",
        locationMode: "precise",
        approximateRadiusM: null,
      },
      envelope,
      idempotentReplay: false,
    } as never);

    await expect(
      executePrivateLocationAction({
        action: newShareAction(),
        vaultOwnerToken,
        userId,
      }),
    ).rejects.toMatchObject({
      name: PrivateLocationActionError.name,
      successfulCount: 0,
      totalCount: 1,
    });
    expect(OneLocationService.revokeGrant).toHaveBeenCalledWith({
      vaultOwnerToken,
      grantId: "grant-mismatch",
    });
  });

  it("rejects an approval response without atomic request and envelope linkage", async () => {
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [],
      ownerGrants: [],
      requests: [
        {
          id: "request-1",
          status: "pending",
          requesterUserId: recipient.userId,
          requesterKeyId: recipient.keyId,
          requesterPublicKeyJwk: recipient.publicKeyJwk,
        },
      ],
    } as never);
    vi.mocked(OneLocationService.approveRequest).mockResolvedValue({
      request: {
        id: "request-1",
        status: "approved",
        approvedGrantId: null,
      },
      grant: {
        id: "grant-unlinked",
        status: "active",
        latestEnvelopeId: null,
        locationMode: "precise",
        approximateRadiusM: null,
      },
      envelope: { ...envelope, id: undefined },
      idempotentReplay: false,
    } as never);
    const action: ClientAction = {
      id: "approval-action-unlinked",
      type: "publish_share",
      summary: "Approve Mom",
      shares: [
        {
          recipientUserId: recipient.userId,
          approvalRequestId: "request-1",
          label: recipient.displayName,
          durationHours: 1,
          locationMode: "precise",
        },
      ],
    };

    await expect(
      executePrivateLocationAction({ action, vaultOwnerToken, userId }),
    ).rejects.toMatchObject({
      name: PrivateLocationActionError.name,
      successfulCount: 0,
    });
    expect(OneLocationService.revokeGrant).toHaveBeenCalledWith({
      vaultOwnerToken,
      grantId: "grant-unlinked",
    });
  });

  it("blocks a Live location before encryption when precise permission is unavailable", async () => {
    vi.mocked(OneLocationService.getPermissionState).mockResolvedValue({
      state: "granted",
      precise: false,
    } as never);

    await expect(
      executePrivateLocationAction({
        action: newShareAction("precise"),
        vaultOwnerToken,
        userId,
      }),
    ).rejects.toThrow(/Precise Location/i);
    expect(encryptLocationForRecipient).not.toHaveBeenCalled();
    expect(OneLocationService.createGrantWithEnvelope).not.toHaveBeenCalled();
  });

  it("reports a partial multi-recipient result without hiding the successful grant", async () => {
    const recipientTwo = {
      ...recipient,
      userId: "recipient-2",
      displayName: "Dad",
      keyId: "recipient-key-2",
    };
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [recipient, recipientTwo],
      ownerGrants: [],
      requests: [],
    } as never);
    vi.mocked(OneLocationService.createGrantWithEnvelope)
      .mockResolvedValueOnce({
        grant: {
          id: "grant-1",
          status: "active",
          latestEnvelopeId: envelope.id,
          locationMode: "approximate",
          approximateRadiusM: 1_000,
        },
        envelope,
        idempotentReplay: false,
      } as never)
      .mockRejectedValueOnce(new Error("network unavailable"));
    const action = newShareAction();
    action.shares = [
      ...action.shares,
      {
        recipientUserId: recipientTwo.userId,
        recipientKeyId: recipientTwo.keyId,
        label: recipientTwo.displayName,
        durationHours: 4,
        locationMode: "approximate",
      },
    ];

    await expect(
      executePrivateLocationAction({ action, vaultOwnerToken, userId }),
    ).resolves.toMatchObject({
      successfulCount: 1,
      totalCount: 2,
      failureDetails: [expect.stringMatching(/Dad.*network unavailable/i)],
    });
    expect(OneLocationService.createGrantWithEnvelope).toHaveBeenCalledTimes(2);
    expect(OneLocationService.revokeGrant).not.toHaveBeenCalledWith({
      vaultOwnerToken,
      grantId: "grant-1",
    });
  });

  it("isolates one recipient's encryption failure and still commits later recipients", async () => {
    const recipientTwo = {
      ...recipient,
      userId: "recipient-2",
      displayName: "Dad",
      keyId: "recipient-key-2",
    };
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [recipient, recipientTwo],
      ownerGrants: [],
      requests: [],
    } as never);
    vi.mocked(encryptLocationForRecipient)
      .mockRejectedValueOnce(new Error("recipient key unavailable"))
      .mockResolvedValueOnce(envelope);
    vi.mocked(OneLocationService.createGrantWithEnvelope).mockResolvedValueOnce({
      grant: {
        id: "grant-2",
        status: "active",
        latestEnvelopeId: envelope.id,
        locationMode: "approximate",
        approximateRadiusM: 1_000,
      },
      envelope,
      idempotentReplay: false,
    } as never);
    const action = newShareAction();
    action.shares = [
      ...action.shares,
      {
        recipientUserId: recipientTwo.userId,
        recipientKeyId: recipientTwo.keyId,
        label: recipientTwo.displayName,
        durationHours: 4,
        locationMode: "approximate",
      },
    ];

    await expect(
      executePrivateLocationAction({ action, vaultOwnerToken, userId }),
    ).resolves.toMatchObject({
      successfulCount: 1,
      totalCount: 2,
      failureDetails: [expect.stringMatching(/Mom.*key unavailable/i)],
    });
    expect(OneLocationService.createGrantWithEnvelope).toHaveBeenCalledTimes(1);
    expect(OneLocationService.createGrantWithEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: "recipient-2" }),
    );
  });

  it("honours a Settings pause before capturing any point", async () => {
    updateOneLocationControlState(userId, (state) => ({
      ...state,
      paused: true,
    }));

    await expect(
      executePrivateLocationAction({
        action: newShareAction(),
        vaultOwnerToken,
        userId,
      }),
    ).rejects.toThrow(/paused on this device/i);
    expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
    expect(encryptLocationForRecipient).not.toHaveBeenCalled();
  });

  it("never republishes an active legacy grant that is queued for revocation", async () => {
    window.localStorage.setItem(
      pendingLocationRevocationStorageKey(userId),
      JSON.stringify(["legacy-grant"]),
    );
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [recipient],
      ownerGrants: [
        {
          id: "legacy-grant",
          status: "active",
          locationMode: "precise",
          recipientUserId: recipient.userId,
          recipientKeyId: recipient.keyId,
        },
      ],
      requests: [],
    } as never);
    const action = newShareAction("precise");
    action.shares[0] = {
      ...action.shares[0],
      grantId: "legacy-grant",
    };

    await expect(
      executePrivateLocationAction({ action, vaultOwnerToken, userId }),
    ).rejects.toThrow(/no longer active/i);
    expect(OneLocationService.storeEnvelope).not.toHaveBeenCalled();
  });
});
