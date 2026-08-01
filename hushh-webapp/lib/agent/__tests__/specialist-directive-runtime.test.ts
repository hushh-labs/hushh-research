import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    captureCurrentPosition: vi.fn(async () => ({
      latitude: 1,
      longitude: 2,
      capturedAt: "t",
    })),
    getState: vi.fn(async () => ({
      recipients: [
        {
          userId: "r1",
          keyId: "k1",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" },
        },
        {
          userId: "r2",
          keyId: "k2",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "cc", y: "dd" },
        },
      ],
      ownerGrants: [
        { id: "g1", status: "active", locationMode: "precise" },
        { id: "g2", status: "active", locationMode: "precise" },
      ],
    })),
    getPermissionState: vi.fn(async () => ({
      state: "granted",
      precise: true,
    })),
    storeEnvelope: vi.fn(async () => ({ ok: true })),
    createPublicInvite: vi.fn(async () => ({
      publicUrl: "https://one.example/p/abc",
    })),
  },
}));
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(async () => ({
    ciphertext: "x",
    iv: "y",
  })),
}));

import { runLocationDirective } from "@/lib/agent/specialist-directive-runtime";
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";

describe("runLocationDirective publish_share", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures once, encrypts per recipient, stores envelopes, returns completed", async () => {
    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-1",
        type: "publish_share",
        shares: [
          { grantId: "g1", recipientKeyId: "k1", label: "Mom" },
          { grantId: "g2", recipientKeyId: "k2", label: "Dad" },
        ],
        summary: "Share with Mom, Dad",
      },
    }, "tok", "u1");
    expect(OneLocationService.captureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(OneLocationService.getState).toHaveBeenCalledTimes(1);
    expect(encryptLocationForRecipient).toHaveBeenCalledTimes(2);
    expect(OneLocationService.storeEnvelope).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "act-1",
      type: "publish_share",
      status: "completed",
    });
    // Coordinate-free result
    expect(JSON.stringify(result)).not.toContain("latitude");
  });

  it("sources the recipient JWK from server state, not the directive payload", async () => {
    await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-2",
        type: "publish_share",
        shares: [{ grantId: "g1", recipientKeyId: "k1", label: "Mom" }],
      },
    }, "tok", "u1");
    // The JWK passed to encryption is the server-sourced one (from getState),
    // never a payload-supplied key.
    expect(encryptLocationForRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPublicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" },
        recipientKeyId: "k1",
      }),
    );
  });

  it("coarsens an approximate grant before encrypting its point", async () => {
    vi.mocked(OneLocationService.getState).mockResolvedValueOnce({
      recipients: [
        {
          userId: "r1",
          keyId: "k1",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "aa", y: "bb" },
        },
      ],
      ownerGrants: [
        {
          id: "g1",
          status: "active",
          locationMode: "approximate",
          approximateRadiusM: 1_000,
        },
      ],
    } as any);

    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-approximate",
        type: "publish_share",
        shares: [{ grantId: "g1", recipientKeyId: "k1", label: "Mom" }],
      },
    }, "tok", "u1");

    expect(result.status).toBe("completed");
    expect(encryptLocationForRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        point: expect.objectContaining({
          locationMode: "approximate",
          approximateRadiusM: 1_000,
        }),
      }),
    );
    const encryptedPoint = vi.mocked(encryptLocationForRecipient).mock
      .calls[0]?.[0].point;
    expect(encryptedPoint?.latitude).not.toBe(1);
    expect(encryptedPoint?.longitude).not.toBe(2);
  });

  it("fails with a friendly error when the recipient has no server key", async () => {
    vi.mocked(OneLocationService.getState).mockResolvedValueOnce({
      recipients: [{ userId: "r1", keyId: "k1", publicKeyJwk: null }],
      ownerGrants: [{ id: "g1", status: "active", locationMode: "precise" }],
    } as any);
    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-3",
        type: "publish_share",
        shares: [{ grantId: "g1", recipientKeyId: "k1", label: "Mom" }],
      },
    }, "tok", "u1");
    expect(OneLocationService.storeEnvelope).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      detail: "Mom hasn't set up location sharing yet",
    }, "tok", "u1");
  });
});

describe("runLocationDirective create_public_link", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures once, creates a public invite, returns completed with publicUrl", async () => {
    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-4",
        type: "create_public_link",
        durationHours: 3,
      },
    }, "tok", "u1");
    expect(OneLocationService.captureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(OneLocationService.createPublicInvite).toHaveBeenCalledTimes(1);
    expect(OneLocationService.createPublicInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        durationHours: 3,
        locationSnapshot: expect.objectContaining({
          locationMode: "approximate",
          approximateRadiusM: expect.any(Number),
        }),
      }),
    );
    const snapshot = vi.mocked(OneLocationService.createPublicInvite).mock
      .calls[0]?.[0].locationSnapshot;
    expect(snapshot?.latitude).not.toBe(1);
    expect(snapshot?.longitude).not.toBe(2);
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "act-4",
      type: "create_public_link",
      status: "completed",
      publicUrl: "https://one.example/p/abc",
    });
    // Coordinate-free result
    expect(JSON.stringify(result)).not.toContain("latitude");
  });
});
