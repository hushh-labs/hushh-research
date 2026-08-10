import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildMarketplaceContactLookups,
  mockMatchMarketplaceContacts,
  mockGetPermissionState,
  mockOpenAppSettings,
} = vi.hoisted(() => ({
  mockBuildMarketplaceContactLookups: vi.fn(),
  mockMatchMarketplaceContacts: vi.fn(),
  mockGetPermissionState: vi.fn(),
  mockOpenAppSettings: vi.fn(),
}));

vi.mock("@/lib/marketplace/contact-matching", () => ({
  buildMarketplaceContactLookups: mockBuildMarketplaceContactLookups,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    getPermissionState: mockGetPermissionState,
    openAppSettings: mockOpenAppSettings,
  },
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: {
    matchMarketplaceContacts: mockMatchMarketplaceContacts,
  },
}));

import {
  openContactPermissionSettings,
  syncOneLocationContactSignals,
  OneLocationContactSyncError,
} from "@/lib/one-location/contact-signals";

describe("one location contact signals", () => {
  beforeEach(() => {
    mockBuildMarketplaceContactLookups.mockReset();
    mockMatchMarketplaceContacts.mockReset();
    mockGetPermissionState.mockReset();
    mockOpenAppSettings.mockReset();
    mockGetPermissionState.mockResolvedValue({ state: "granted" });
  });

  it("uses hashed contact lookups and strips phone digits from returned matches", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      totalContacts: 3,
      sourcePlatform: "android",
      region: "IN",
      limited: false,
      truncated: false,
      lookups: [
        {
          hash: "a".repeat(64),
          last4: "0101",
          displayName: "Avery Stone",
        },
        {
          hash: "b".repeat(64),
          last4: "9911",
          displayName: "Investor D",
        },
      ],
    });
    mockMatchMarketplaceContacts.mockResolvedValue([
      {
        user_id: "user_d",
        kind: "one_user",
        display_name: "Investor D",
        phone_last4: "9911",
        profile: {},
      },
    ]);

    const result = await syncOneLocationContactSignals({
      idToken: "id-token",
      accountPhoneNumber: "+919000000000",
      contactLimit: 20,
      matchLimit: 5,
    });

    expect(mockBuildMarketplaceContactLookups).toHaveBeenCalledWith({
      limit: 20,
      accountPhoneNumber: "+919000000000",
      signal: undefined,
    });
    // one_network scope is what makes ordinary One users matchable; the
    // marketplace scope only returns published Connect profiles.
    expect(mockMatchMarketplaceContacts).toHaveBeenCalledWith("id-token", {
      phone_lookups: [
        { hash: "a".repeat(64), last4: "0101" },
        { hash: "b".repeat(64), last4: "9911" },
      ],
      limit: 5,
      scope: "one_network",
    });
    expect(result).toMatchObject({
      matchedUserIds: ["user_d"],
      totalContacts: 3,
      inviteCandidateCount: 2,
      sourcePlatform: "android",
      region: "IN",
      limited: false,
      truncated: false,
    });
    expect(result.matches[0]).not.toHaveProperty("phone_last4");
    expect(JSON.stringify(result)).not.toContain("9911");
    expect(JSON.stringify(result)).not.toContain("0101");
  });

  it("returns invite candidates without calling the matcher when contacts have no phones", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      totalContacts: 4,
      sourcePlatform: "ios",
      region: "US",
      limited: false,
      truncated: false,
      lookups: [],
    });

    const result = await syncOneLocationContactSignals({ idToken: "id-token" });

    expect(mockMatchMarketplaceContacts).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      matches: [],
      matchedUserIds: [],
      totalContacts: 4,
      inviteCandidateCount: 4,
      sourcePlatform: "ios",
    });
  });

  it("reports a denied permission as a typed failure without reading contacts", async () => {
    mockGetPermissionState.mockResolvedValue({ state: "denied" });

    await expect(
      syncOneLocationContactSignals({ idToken: "id-token" }),
    ).rejects.toMatchObject({ failure: "denied" });
    // The read must not be attempted: on a denied permission the OS never
    // prompts again, so calling through would only produce a confusing error.
    expect(mockBuildMarketplaceContactLookups).not.toHaveBeenCalled();
  });

  it.each([
    ["restricted", "restricted"],
    ["unavailable", "unavailable"],
  ])("maps a %s permission to the %s failure", async (state, failure) => {
    mockGetPermissionState.mockResolvedValue({ state });

    const error = await syncOneLocationContactSignals({
      idToken: "id-token",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OneLocationContactSyncError);
    expect((error as OneLocationContactSyncError).failure).toBe(failure);
  });

  it("treats a plugin that cannot report state as an unavailable platform", async () => {
    mockGetPermissionState.mockRejectedValue(new Error("no such plugin"));

    await expect(
      syncOneLocationContactSignals({ idToken: "id-token" }),
    ).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("proceeds when access is limited so partial books still match", async () => {
    mockGetPermissionState.mockResolvedValue({ state: "limited" });
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      totalContacts: 2,
      sourcePlatform: "ios",
      region: "US",
      limited: true,
      truncated: false,
      lookups: [{ hash: "c".repeat(64), last4: "0101", displayName: "Ada" }],
    });
    mockMatchMarketplaceContacts.mockResolvedValue([]);

    const result = await syncOneLocationContactSignals({ idToken: "id-token" });

    expect(result.limited).toBe(true);
    expect(result.matchedUserIds).toEqual([]);
  });

  it("reports whether the settings page actually opened", async () => {
    mockOpenAppSettings.mockResolvedValue({ opened: true });
    await expect(openContactPermissionSettings()).resolves.toBe(true);

    mockOpenAppSettings.mockRejectedValue(new Error("unsupported"));
    await expect(openContactPermissionSettings()).resolves.toBe(false);
  });
});
