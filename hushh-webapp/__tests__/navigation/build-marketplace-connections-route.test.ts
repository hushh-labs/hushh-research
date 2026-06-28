import { describe, expect, it } from "vitest";

import { buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";

describe("buildMarketplaceConnectionsRoute", () => {
  it("returns the bare consents path when no entries are provided", () => {
    expect(buildMarketplaceConnectionsRoute()).toBe("/consents");
  });

  it("maps tab to the tab query parameter", () => {
    expect(
      buildMarketplaceConnectionsRoute({ tab: "pending" })
    ).toBe("/consents?tab=pending");

    expect(
      buildMarketplaceConnectionsRoute({ tab: "previous" })
    ).toBe("/consents?tab=previous");
  });

  it("maps selected to the requestId query parameter", () => {
    expect(
      buildMarketplaceConnectionsRoute({
        selected: "req-1",
      })
    ).toBe("/consents?requestId=req-1");
  });

  it("omits query parameters when values are null", () => {
    expect(
      buildMarketplaceConnectionsRoute({
        tab: null,
        selected: null,
      })
    ).toBe("/consents");
  });
});