import { describe, expect, it } from "vitest";

import {
  marketplaceInvestorActionIdentity,
  marketplaceSavedInvestorLeadFromAction,
  marketplaceSavedInvestorLeadsFromActions,
} from "@/lib/marketplace/investor-discovery";
import type { MarketplaceInvestorActionRecord } from "@/lib/services/ria-service";

function action(
  overrides: Partial<MarketplaceInvestorActionRecord> = {},
): MarketplaceInvestorActionRecord {
  return {
    id: "action-1",
    actor_user_id: "ria-1",
    ria_profile_id: "ria-profile-1",
    source_type: "public_sec",
    target_key: "public_sec:42",
    public_profile_id: "42",
    target_user_id: null,
    action: "shortlist",
    status: "shortlisted",
    profile: {
      id: "public_sec:42",
      source_type: "public_sec",
      public_profile_id: "42",
      display_name: "Ipsen Advisor Group LLC",
      headline: "Public institutional filer",
      strategy_summary: "SEC-backed investor discovery profile.",
    },
    metadata: { surface: "marketplace" },
    ...overrides,
  };
}

describe("marketplace saved investor leads", () => {
  it("uses target_key as the stable saved-lead identity", () => {
    expect(marketplaceInvestorActionIdentity(action())).toBe("public_sec:42");
  });

  it("projects a shortlisted marketplace action into a saved lead", () => {
    const lead = marketplaceSavedInvestorLeadFromAction(action());

    expect(lead?.id).toBe("public_sec:42");
    expect(lead?.investor.display_name).toBe("Ipsen Advisor Group LLC");
    expect(lead?.investor.public_profile_id).toBe("42");
  });

  it("does not treat passed actions as saved leads", () => {
    expect(
      marketplaceSavedInvestorLeadFromAction(
        action({ action: "pass", status: "passed" }),
      ),
    ).toBeNull();
  });

  it("deduplicates saved leads by stable identity rather than display name", () => {
    const leads = marketplaceSavedInvestorLeadsFromActions([
      action({ id: "action-1", target_key: "public_sec:42" }),
      action({ id: "action-2", target_key: "public_sec:42" }),
      action({
        id: "action-3",
        target_key: "public_sec:43",
        public_profile_id: "43",
        profile: {
          id: "public_sec:43",
          source_type: "public_sec",
          public_profile_id: "43",
          display_name: "Ipsen Advisor Group LLC",
        },
      }),
    ]);

    expect(leads.map((lead) => lead.id)).toEqual(["public_sec:42", "public_sec:43"]);
  });

  it("falls back to canonical source identities when target_key is absent", () => {
    expect(
      marketplaceInvestorActionIdentity(
        action({ target_key: null, source_type: "public_sec", public_profile_id: "44" }),
      ),
    ).toBe("public_sec:44");

    expect(
      marketplaceInvestorActionIdentity(
        action({
          target_key: null,
          source_type: "hushh_user",
          public_profile_id: null,
          target_user_id: "investor-1",
        }),
      ),
    ).toBe("investor-1");
  });
});
