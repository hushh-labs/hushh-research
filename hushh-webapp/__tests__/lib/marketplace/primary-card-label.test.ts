import { describe, expect, it } from "vitest";

import { resolveMarketplacePrimaryCardLabel } from "@/lib/marketplace/primary-card-label";

describe("resolveMarketplacePrimaryCardLabel", () => {
  it("labels RIA primary actions as send requests when the handler sends a request", () => {
    expect(
      resolveMarketplacePrimaryCardLabel({
        kind: "ria",
        currentPersona: "ria",
      }),
    ).toBe("Send request");
  });

  it("preserves investor advisory copy for advisor requests", () => {
    expect(
      resolveMarketplacePrimaryCardLabel({
        kind: "ria",
        currentPersona: "investor",
      }),
    ).toBe("Request advisory");
  });

  it("preserves genuine profile viewing for discovery-only investor cards", () => {
    expect(
      resolveMarketplacePrimaryCardLabel({
        kind: "investor",
        currentPersona: "ria",
        canConnect: false,
        isInvestorShortlistable: false,
      }),
    ).toBe("View profile");
  });

  it("keeps connect and shortlist states distinct", () => {
    expect(
      resolveMarketplacePrimaryCardLabel({
        kind: "investor",
        currentPersona: "ria",
        canConnect: true,
      }),
    ).toBe("Send request");

    expect(
      resolveMarketplacePrimaryCardLabel({
        kind: "investor",
        currentPersona: "ria",
        isInvestorShortlistable: true,
      }),
    ).toBe("Save lead");
  });

  it("shows saved lead state for already-shortlisted investors", () => {
    expect(
      resolveMarketplacePrimaryCardLabel({
        kind: "investor",
        currentPersona: "ria",
        isInvestorShortlistable: true,
        isInvestorShortlisted: true,
      }),
    ).toBe("Saved lead");
  });
});
