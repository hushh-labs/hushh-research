// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { runCheckIn } from "@/lib/one-location/check-in-trigger";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    createGrantWithEnvelope: vi.fn(),
    revokeGrant: vi.fn(),
    getPermissionState: vi.fn(async () => ({
      state: "granted",
      precise: true,
    })),
  },
}));

function atomicResponse(id: string) {
  return {
    grant: {
      id,
      locationMode: "precise",
      approximateRadiusM: null,
      latestEnvelopeId: `envelope-${id}`,
    },
    envelope: { id: `envelope-${id}` },
    idempotentReplay: false,
  } as never;
}

describe("runCheckIn", () => {
  it("creates one grant per recipient with the chosen duration + note and publishes", async () => {
    const created: any[] = [];
    vi.mocked(OneLocationService.createGrantWithEnvelope).mockImplementation(
      async (p: any) => {
        created.push(p);
        return atomicResponse(`g-${p.recipientUserId}`);
      },
    );
    const prepared: string[] = [];
    const recipients = [
      { userId: "a", keyId: "ka", publicKeyJwk: {}, canReceiveLocation: true },
      { userId: "b", keyId: "kb", publicKeyJwk: {}, canReceiveLocation: true },
    ] as any;
    const ids = await runCheckIn({
      userId: "owner",
      vaultOwnerToken: "t",
      recipients,
      point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
      durationHours: 2,
      note: "on my way",
      operationId: "check-in-action",
      prepareEnvelope: async (recipient) => {
        prepared.push(recipient.userId);
        return { id: `client-${recipient.userId}` } as never;
      },
    });
    expect(ids).toEqual(["g-a", "g-b"]);
    expect(created[0]).toMatchObject({ durationHours: 2, reason: "on my way" });
    expect(created[0]).toMatchObject({
      shareKind: "check_in",
      locationMode: "precise",
      approximateRadiusM: null,
      clientOperationId: "check-in:check-in-action:a",
    });
    expect(prepared).toEqual(["a", "b"]);
  });

  it("uses 'Checking in' as the reason when note is null", async () => {
    const created: any[] = [];
    vi.mocked(OneLocationService.createGrantWithEnvelope).mockImplementation(
      async (p: any) => {
        created.push(p);
        return atomicResponse(`g-${p.recipientUserId}`);
      },
    );
    const recipients = [
      { userId: "a", keyId: "ka", publicKeyJwk: {}, canReceiveLocation: true },
    ] as any;
    await runCheckIn({
      userId: "owner",
      vaultOwnerToken: "t",
      recipients,
      point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
      durationHours: 1,
      note: null,
      prepareEnvelope: async () => ({ id: "client-envelope" }) as never,
    });
    expect(created[0]).toMatchObject({ reason: "Checking in" });
  });

  it("continues to later recipients when one atomic check-in fails", async () => {
    vi.mocked(OneLocationService.createGrantWithEnvelope)
      .mockRejectedValueOnce(new Error("first recipient unavailable"))
      .mockResolvedValueOnce(atomicResponse("g-b"));
    const recipients = [
      { userId: "a", keyId: "ka", publicKeyJwk: {}, canReceiveLocation: true },
      { userId: "b", keyId: "kb", publicKeyJwk: {}, canReceiveLocation: true },
    ] as any;

    await expect(
      runCheckIn({
        userId: "owner",
        vaultOwnerToken: "t",
        recipients,
        point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
        durationHours: 1,
        operationId: "partial-check-in",
        prepareEnvelope: async (recipient) =>
          ({ id: `client-${recipient.userId}` }) as never,
      }),
    ).resolves.toEqual(["g-b"]);
    expect(OneLocationService.createGrantWithEnvelope).toHaveBeenCalledTimes(2);
  });

  it("throws when no recipients are provided", async () => {
    await expect(
      runCheckIn({
        userId: "owner",
        vaultOwnerToken: "t",
        recipients: [],
        point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
        durationHours: 1,
        note: null,
        prepareEnvelope: async () => ({ id: "client-envelope" }) as never,
      }),
    ).rejects.toThrow("No check-in recipients provided.");
  });
});
