import { describe, expect, it } from "vitest";

import { formatMarketplaceDisplayName } from "@/lib/marketplace/display-name";

describe("formatMarketplaceDisplayName", () => {
  it("normalizes uppercase marketplace organization names for display", () => {
    expect(formatMarketplaceDisplayName("BERKSHIRE HATHAWAY INC")).toBe(
      "Berkshire Hathaway Inc"
    );
    expect(formatMarketplaceDisplayName("CITADEL ADVISORS LLC")).toBe("Citadel Advisors LLC");
    expect(formatMarketplaceDisplayName("MILLENNIUM MANAGEMENT LLC")).toBe(
      "Millennium Management LLC"
    );
  });

  it("preserves legal suffixes, punctuation, and known acronyms", () => {
    expect(formatMarketplaceDisplayName("BRIDGEWATER ASSOCIATES, LP")).toBe(
      "Bridgewater Associates, LP"
    );
    expect(formatMarketplaceDisplayName("PERSHING SQUARE CAPITAL MANAGEMENT, L.P.")).toBe(
      "Pershing Square Capital Management, L.P."
    );
    expect(formatMarketplaceDisplayName("ABC AI CAPITAL LLC")).toBe("Abc AI Capital LLC");
    expect(formatMarketplaceDisplayName("RIA PARTNERS LLC")).toBe("RIA Partners LLC");
    expect(formatMarketplaceDisplayName("SEC ETF USA UK")).toBe("SEC ETF USA UK");
  });

  it("keeps already-readable and intentionally mixed-case names unchanged", () => {
    expect(formatMarketplaceDisplayName("Bridgewater Associates, LP")).toBe(
      "Bridgewater Associates, LP"
    );
    expect(formatMarketplaceDisplayName("iShares")).toBe("iShares");
  });

  it("handles empty, whitespace, and punctuation-heavy values safely", () => {
    expect(formatMarketplaceDisplayName("")).toBe("");
    expect(formatMarketplaceDisplayName("   ")).toBe("");
    expect(formatMarketplaceDisplayName("  CITADEL ADVISORS, LLC  ")).toBe(
      "Citadel Advisors, LLC"
    );
    expect(formatMarketplaceDisplayName("A&B CAPITAL LLC")).toBe("A&B Capital LLC");
  });
});
