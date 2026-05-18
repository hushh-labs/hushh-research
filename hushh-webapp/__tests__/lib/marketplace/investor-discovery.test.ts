import { describe, expect, it } from "vitest";

import {
  isMarketplaceInvestorConnectable,
  isMarketplaceInvestorShortlistable,
  marketplaceInvestorActionTarget,
  marketplaceInvestorCardId,
  marketplaceInvestorActions,
  marketplaceInvestorCurationLabel,
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
      curation_tier: "showcase",
      actions: ["shortlist", "view_more"],
    };

    expect(marketplaceInvestorCardId(investor)).toBe("public_sec:42");
    expect(marketplaceInvestorUserId(investor)).toBeNull();
    expect(isMarketplaceInvestorConnectable(investor)).toBe(false);
    expect(isMarketplaceInvestorShortlistable(investor)).toBe(true);
    expect(marketplaceInvestorActions(investor)).toEqual(["shortlist", "view_more"]);
    expect(marketplaceInvestorActionTarget(investor)).toEqual({
      source_type: "public_sec",
      public_profile_id: "42",
      target_user_id: null,
    });
    expect(marketplaceInvestorSourceLabel(investor)).toBe("Public SEC profile");
    expect(marketplaceInvestorCurationLabel(investor)).toBe("Showcase");
  });

  it("allows qualified Hushh investors to be connection subjects", () => {
    const investor: MarketplaceInvestor = {
      source_type: "hushh_user",
      user_id: "hushh_investor_1",
      display_name: "Avery Stone",
      connectable: true,
      admission_status: "qualified",
      curation_tier: "qualified",
      actions: ["connect", "view_more"],
    };

    expect(marketplaceInvestorCardId(investor)).toBe("hushh_investor_1");
    expect(marketplaceInvestorUserId(investor)).toBe("hushh_investor_1");
    expect(isMarketplaceInvestorConnectable(investor)).toBe(true);
    expect(isMarketplaceInvestorShortlistable(investor)).toBe(false);
    expect(marketplaceInvestorActions(investor)).toEqual(["connect", "view_more"]);
    expect(marketplaceInvestorActionTarget(investor)).toEqual({
      source_type: "hushh_user",
      public_profile_id: null,
      target_user_id: "hushh_investor_1",
    });
    expect(marketplaceInvestorSourceLabel(investor)).toBe("Qualified Hushh investor");
    expect(marketplaceInvestorCurationLabel(investor)).toBe("Qualified");
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
