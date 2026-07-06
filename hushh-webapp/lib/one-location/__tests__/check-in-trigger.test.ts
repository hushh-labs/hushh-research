// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { runCheckIn } from "@/lib/one-location/check-in-trigger";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    createGrant: vi.fn(),
  },
}));

describe("runCheckIn", () => {
  it("creates one grant per recipient with the chosen duration + note and publishes", async () => {
    const created: any[] = [];
    vi.mocked(OneLocationService.createGrant).mockImplementation(async (p: any) => {
      created.push(p);
      return { id: `g-${p.recipientUserId}` } as any;
    });
    const published: string[] = [];
    const recipients = [
      { userId: "a", keyId: "ka", publicKeyJwk: {}, canReceiveLocation: true },
      { userId: "b", keyId: "kb", publicKeyJwk: {}, canReceiveLocation: true },
    ] as any;
    const ids = await runCheckIn({
      vaultOwnerToken: "t",
      recipients,
      point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
      durationHours: 2,
      note: "on my way",
      publish: async (grant) => { published.push(grant.id); },
    });
    expect(ids).toEqual(["g-a", "g-b"]);
    expect(created[0]).toMatchObject({ durationHours: 2, reason: "on my way" });
    expect(published).toEqual(["g-a", "g-b"]);
  });

  it("uses 'Checking in' as the reason when note is null", async () => {
    const created: any[] = [];
    vi.mocked(OneLocationService.createGrant).mockImplementation(async (p: any) => {
      created.push(p);
      return { id: `g-${p.recipientUserId}` } as any;
    });
    const recipients = [
      { userId: "a", keyId: "ka", publicKeyJwk: {}, canReceiveLocation: true },
    ] as any;
    await runCheckIn({
      vaultOwnerToken: "t",
      recipients,
      point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
      durationHours: 1,
      note: null,
      publish: async () => {},
    });
    expect(created[0]).toMatchObject({ reason: "Checking in" });
  });

  it("throws when no recipients are provided", async () => {
    await expect(
      runCheckIn({
        vaultOwnerToken: "t",
        recipients: [],
        point: { latitude: 1, longitude: 2, accuracyM: 3 } as any,
        durationHours: 1,
        note: null,
        publish: async () => {},
      }),
    ).rejects.toThrow("No check-in recipients provided.");
  });
});
