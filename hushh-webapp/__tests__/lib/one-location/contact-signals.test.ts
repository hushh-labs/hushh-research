import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBuildMarketplaceContactLookups, mockMatchMarketplaceContacts } =
  vi.hoisted(() => ({
    mockBuildMarketplaceContactLookups: vi.fn(),
    mockMatchMarketplaceContacts: vi.fn(),
  }));

vi.mock("@/lib/marketplace/contact-matching", () => ({
  buildMarketplaceContactLookups: mockBuildMarketplaceContactLookups,
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: {
    matchMarketplaceContacts: mockMatchMarketplaceContacts,
  },
}));

import { syncOneLocationContactSignals } from "@/lib/one-location/contact-signals";

describe("one location contact signals", () => {
  beforeEach(() => {
    mockBuildMarketplaceContactLookups.mockReset();
    mockMatchMarketplaceContacts.mockReset();
  });

  it("uses hashed contact lookups and strips phone digits from returned matches", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      totalContacts: 3,
      sourcePlatform: "android",
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
        kind: "investor",
        display_name: "Investor D",
        phone_last4: "9911",
        profile: {},
      },
    ]);

    const result = await syncOneLocationContactSignals({
      idToken: "id-token",
      contactLimit: 20,
      matchLimit: 5,
    });

    expect(mockBuildMarketplaceContactLookups).toHaveBeenCalledWith({
      limit: 20,
    });
    expect(mockMatchMarketplaceContacts).toHaveBeenCalledWith("id-token", {
      phone_lookups: [
        { hash: "a".repeat(64), last4: "0101" },
        { hash: "b".repeat(64), last4: "9911" },
      ],
      limit: 5,
    });
    expect(result).toMatchObject({
      matchedUserIds: ["user_d"],
      totalContacts: 3,
      inviteCandidateCount: 2,
      sourcePlatform: "android",
    });
    expect(result.matches[0]).not.toHaveProperty("phone_last4");
    expect(JSON.stringify(result)).not.toContain("9911");
    expect(JSON.stringify(result)).not.toContain("0101");
  });

  it("returns invite candidates without calling the matcher when contacts have no phones", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      totalContacts: 4,
      sourcePlatform: "ios",
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
});
