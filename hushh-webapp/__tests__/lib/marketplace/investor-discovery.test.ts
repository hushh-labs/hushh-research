import { describe, expect, it } from "vitest";

import {
  isMarketplaceInvestorConnectable,
  marketplaceInvestorCardId,
  marketplaceInvestorSourceLabel,
  marketplaceInvestorUserId,
} from "@/lib/marketplace/investor-discovery";
import type { MarketplaceInvestor } from "@/lib/services/ria-service";

describe("marketplace investor discovery helpers", () => {
  it("keeps public SEC profiles discovery-only", () => {
    const investor: MarketplaceInvestor = {
      id: "public_sec:42",
      source_type: "public_sec",
      user_id: null,
      public_profile_id: "42",
      display_name: "Morgan Public",
      connectable: false,
    };

    expect(marketplaceInvestorCardId(investor)).toBe("public_sec:42");
    expect(marketplaceInvestorUserId(investor)).toBeNull();
    expect(isMarketplaceInvestorConnectable(investor)).toBe(false);
    expect(marketplaceInvestorSourceLabel(investor)).toBe("Public SEC profile");
  });

  it("allows opted-in Hushh investors to be connection subjects", () => {
    const investor: MarketplaceInvestor = {
      source_type: "hushh_user",
      user_id: "hushh_investor_1",
      display_name: "Avery Stone",
      connectable: true,
    };

    expect(marketplaceInvestorCardId(investor)).toBe("hushh_investor_1");
    expect(marketplaceInvestorUserId(investor)).toBe("hushh_investor_1");
    expect(isMarketplaceInvestorConnectable(investor)).toBe(true);
    expect(marketplaceInvestorSourceLabel(investor)).toBe("Opted-in Hushh investor");
  });

  it("honors explicit non-connectable state even for Hushh users", () => {
    const investor: MarketplaceInvestor = {
      source_type: "hushh_user",
      user_id: "hushh_investor_locked",
      display_name: "Locked Investor",
      connectable: false,
    };

    expect(isMarketplaceInvestorConnectable(investor)).toBe(false);
  });
});

