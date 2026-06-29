import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasLocalContactMatchFixture,
  loadConnectPayload,
  loadContactMatches,
} from "@/lib/connect/service";

const mockBuildMarketplaceContactLookups = vi.fn();
const mockBuildMarketplaceContactLookupsFromQuery = vi.fn();
const mockMatchMarketplaceContacts = vi.fn();
const mockListConsentEntries = vi.fn();

vi.mock("@/lib/marketplace/contact-matching", () => ({
  buildMarketplaceContactLookups: (...args: unknown[]) =>
    mockBuildMarketplaceContactLookups(...args),
  buildMarketplaceContactLookupsFromQuery: (...args: unknown[]) =>
    mockBuildMarketplaceContactLookupsFromQuery(...args),
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  ConsentCenterService: {
    listEntries: (...args: unknown[]) => mockListConsentEntries(...args),
  },
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
    mockBuildMarketplaceContactLookupsFromQuery.mockReset();
    mockMatchMarketplaceContacts.mockReset();
    mockListConsentEntries.mockReset();
    mockMatchMarketplaceContacts.mockResolvedValue([]);
    mockBuildMarketplaceContactLookupsFromQuery.mockResolvedValue({
      phoneLookups: [],
      emailLookups: [],
    });
    mockListConsentEntries.mockResolvedValue({ items: [] });
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
      phoneLookups: [
        {
          hash: "a".repeat(64),
          last4: "0101",
          displayName: "Local Contact Name",
        },
      ],
      emailLookups: [
        {
          hash: "b".repeat(64),
          displayName: "Local Contact Name",
          domain: "example.com",
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
      email_lookups: [
        {
          hash: "b".repeat(64),
        },
      ],
      limit: 50,
    });
    expect(result.matches).toHaveLength(1);
    expect(JSON.stringify(mockMatchMarketplaceContacts.mock.calls[0])).not.toContain(
      "Local Contact Name",
    );
    expect(JSON.stringify(mockMatchMarketplaceContacts.mock.calls[0])).not.toContain(
      "example.com",
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
      phoneLookups: [
        {
          hash: "b".repeat(64),
          last4: "2222",
          displayName: "Fixture Contact",
        },
      ],
      emailLookups: [],
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

  it("uses secure contact matching for exact email search without sending the raw query", async () => {
    const riaService = await import("@/lib/services/ria-service");
    vi.mocked(riaService.RiaService.searchRias).mockResolvedValue([]);
    vi.mocked(riaService.RiaService.searchInvestors).mockResolvedValue([]);
    vi.mocked(riaService.RiaService.listClients).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
      has_more: false,
    });
    vi.mocked(riaService.RiaService.listInvestorActions).mockResolvedValue([]);
    mockMatchMarketplaceContacts.mockResolvedValue([
      {
        user_id: "matched_user",
        kind: "investor",
        display_name: "Matched Investor",
        matched_by: "email",
        profile: {
          id: "hushh_user:matched_user",
          source_type: "hushh_user",
          user_id: "matched_user",
          display_name: "Matched Investor",
          connectable: true,
          exposure_enabled: true,
          visibility_posture: "default_available",
        },
      },
    ]);
    mockBuildMarketplaceContactLookupsFromQuery.mockResolvedValue({
      phoneLookups: [],
      emailLookups: [{ hash: "c".repeat(64) }],
    });

    const payload = await loadConnectPayload({
      idToken: "id-token",
      userId: "viewer",
      persona: "investor",
      query: "Person@Example.com",
    });

    expect(payload.contactMatches).toHaveLength(1);
    expect(mockMatchMarketplaceContacts).toHaveBeenCalledWith(
      "id-token",
      expect.objectContaining({
        phone_lookups: [],
        email_lookups: [
          {
            hash: "c".repeat(64),
          },
        ],
      }),
    );
    expect(JSON.stringify(mockMatchMarketplaceContacts.mock.calls[0])).not.toContain(
      "Person@Example.com",
    );
  });

  it("clamps marketplace discovery limits to the backend API contract", async () => {
    const riaService = await import("@/lib/services/ria-service");
    vi.mocked(riaService.RiaService.searchRias).mockResolvedValue([]);
    vi.mocked(riaService.RiaService.searchInvestors).mockResolvedValue([]);
    vi.mocked(riaService.RiaService.listClients).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
      has_more: false,
    });
    vi.mocked(riaService.RiaService.listInvestorActions).mockResolvedValue([]);

    await loadConnectPayload({
      idToken: "id-token",
      userId: "viewer",
      persona: "investor",
      limit: 64,
    });

    expect(riaService.RiaService.searchRias).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
    expect(riaService.RiaService.searchInvestors).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });
});
