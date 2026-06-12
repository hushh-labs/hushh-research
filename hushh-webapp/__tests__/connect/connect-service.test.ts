import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasLocalContactMatchFixture, loadContactMatches } from "@/lib/connect/service";

const mockBuildMarketplaceContactLookups = vi.fn();
const mockMatchMarketplaceContacts = vi.fn();

vi.mock("@/lib/marketplace/contact-matching", () => ({
  buildMarketplaceContactLookups: (...args: unknown[]) =>
    mockBuildMarketplaceContactLookups(...args),
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: {
    searchRias: vi.fn(),
    searchInvestors: vi.fn(),
    searchInvestorDeck: vi.fn(),
    listClients: vi.fn(),
    listInvestorActions: vi.fn(),
    matchMarketplaceContacts: (...args: unknown[]) =>
      mockMatchMarketplaceContacts(...args),
  },
  isIAMSchemaNotReadyError: () => false,
}));

describe("Connect service contact matching", () => {
  beforeEach(() => {
    mockBuildMarketplaceContactLookups.mockReset();
    mockMatchMarketplaceContacts.mockReset();
    window.localStorage.clear();
  });

  it("sends only secure contact hashes and last4 values to the marketplace API", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      lookups: [
        {
          hash: "a".repeat(64),
          last4: "0101",
          displayName: "Local Contact Name",
        },
      ],
      totalContacts: 1,
      sourcePlatform: "ios",
    });
    mockMatchMarketplaceContacts.mockResolvedValue([
      {
        user_id: "matched_user",
        kind: "ria",
        display_name: "Matched Advisor",
        phone_last4: "0101",
        profile: {
          id: "ria_1",
          user_id: "matched_user",
          display_name: "Matched Advisor",
          verification_status: "active",
          exposure_enabled: true,
          visibility_posture: "default_available",
        },
      },
    ]);

    const result = await loadContactMatches("id-token", { limit: 25 });

    expect(mockBuildMarketplaceContactLookups).toHaveBeenCalledWith({ limit: 25 });
    expect(mockMatchMarketplaceContacts).toHaveBeenCalledWith("id-token", {
      phone_lookups: [
        {
          hash: "a".repeat(64),
          last4: "0101",
        },
      ],
      limit: 50,
    });
    expect(result.matches).toHaveLength(1);
    expect(JSON.stringify(mockMatchMarketplaceContacts.mock.calls[0])).not.toContain(
      "Local Contact Name",
    );
  });

  it("can use an explicit local web fixture when the backend match API is unavailable", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      lookups: [
        {
          hash: "b".repeat(64),
          last4: "2222",
          displayName: "Fixture Contact",
        },
      ],
      totalContacts: 1,
      sourcePlatform: "web",
    });
    mockMatchMarketplaceContacts.mockRejectedValue(new Error("backend offline"));
    window.localStorage.setItem(
      "hushh:dev:marketplace-contact-matches",
      JSON.stringify([
        {
          user_id: "fixture_user",
          kind: "investor",
          display_name: "Fixture Investor",
          phone_last4: "2222",
          profile: {
            id: "fixture_user",
            source_type: "hushh_user",
            user_id: "fixture_user",
            display_name: "Fixture Investor",
            connectable: true,
            exposure_enabled: true,
            visibility_posture: "default_available",
          },
        },
      ]),
    );

    const result = await loadContactMatches("id-token");

    expect(result.error).toBeUndefined();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.display_name).toBe("Fixture Investor");
    expect(result.sourcePlatform).toBe("web");
  });

  it("reports whether a local contact match fixture is available", () => {
    expect(hasLocalContactMatchFixture()).toBe(false);

    window.localStorage.setItem(
      "hushh:dev:marketplace-contact-matches",
      JSON.stringify([
        {
          user_id: "fixture_user",
          kind: "investor",
          display_name: "Fixture Investor",
        },
      ]),
    );

    expect(hasLocalContactMatchFixture()).toBe(true);
  });
});
