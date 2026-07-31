import type { MarketplaceInvestor } from "@/lib/services/ria-service";

export function marketplaceInvestorCardId(investor: MarketplaceInvestor): string {
  const explicitId = String(investor.id || "").trim();
  if (explicitId) return explicitId;

  const userId = marketplaceInvestorUserId(investor);
  if (userId) return userId;

  const publicProfileId = String(investor.public_profile_id || "").trim();
  if (publicProfileId) return `public_sec:${publicProfileId}`;

  return `investor:${String(investor.display_name || "unknown").trim().toLowerCase()}`;
}

export function marketplaceInvestorUserId(investor: MarketplaceInvestor): string | null {
  const userId = String(investor.user_id || "").trim();
  return userId || null;
}

export function isPublicSecMarketplaceInvestor(investor: MarketplaceInvestor): boolean {
  return String(investor.source_type || "").toLowerCase() === "public_sec";
}

export function isMarketplaceInvestorConnectable(investor: MarketplaceInvestor): boolean {
  if (isPublicSecMarketplaceInvestor(investor)) return false;
  if (investor.connectable === false) return false;
  return Boolean(marketplaceInvestorUserId(investor));
}

export function marketplaceInvestorActions(investor: MarketplaceInvestor): string[] {
  if (Array.isArray(investor.actions) && investor.actions.length > 0) {
    return investor.actions
      .map((action) => String(action || "").trim().toLowerCase())
      .filter(Boolean);
  }
  if (isPublicSecMarketplaceInvestor(investor)) return ["shortlist", "view_more"];
  if (isMarketplaceInvestorConnectable(investor)) return ["connect", "view_more"];
  return ["view_more"];
}

export function isMarketplaceInvestorShortlistable(investor: MarketplaceInvestor): boolean {
  return marketplaceInvestorActions(investor).includes("shortlist");
}

export function marketplaceInvestorActionTarget(investor: MarketplaceInvestor): {
  source_type: "public_sec" | "hushh_user";
  public_profile_id?: string | number | null;
  target_user_id?: string | null;
} {
  if (isPublicSecMarketplaceInvestor(investor)) {
    const publicProfileId = investor.public_profile_id ?? (
      String(investor.id || "").startsWith("public_sec:")
        ? String(investor.id).replace("public_sec:", "")
        : null
    );
    return {
      source_type: "public_sec",
      public_profile_id: publicProfileId,
      target_user_id: null,
    };
  }

  return {
    source_type: "hushh_user",
    public_profile_id: null,
    target_user_id: marketplaceInvestorUserId(investor),
  };
}

export function marketplaceInvestorSourceLabel(investor: MarketplaceInvestor): string | null {
  if (isPublicSecMarketplaceInvestor(investor)) return "Public SEC profile";
  if (String(investor.source_type || "").toLowerCase() === "hushh_user") {
    return "Qualified Hushh investor";
  }
  return null;
}

export function marketplaceInvestorCurationLabel(investor: MarketplaceInvestor): string | null {
  const tier = String(investor.curation_tier || "").trim().toLowerCase();
  if (tier === "showcase") return "Showcase";
  if (tier === "qualified") return "Qualified";
  return null;
}
