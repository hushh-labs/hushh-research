import type { Persona } from "@/lib/services/ria-service";

export type MarketplacePrimaryCardLabelInput = {
  kind: "ria" | "investor";
  isTestProfile?: boolean;
  isActionLoading?: boolean;
  currentPersona: Persona;
  canConnect?: boolean;
  isInvestorShortlistable?: boolean;
  isInvestorShortlisted?: boolean;
};

export function resolveMarketplacePrimaryCardLabel({
  kind,
  isTestProfile = false,
  isActionLoading = false,
  currentPersona,
  canConnect = false,
  isInvestorShortlistable = false,
  isInvestorShortlisted = false,
}: MarketplacePrimaryCardLabelInput): string {
  if (isTestProfile) {
    return kind === "investor" && currentPersona === "ria" ? "Open workspace" : "Demo";
  }

  if (isActionLoading) return "Connecting...";

  if (kind === "ria") {
    return currentPersona === "investor" ? "Request advisory" : "Send request";
  }

  if (isInvestorShortlisted) return "Saved lead";
  if (isInvestorShortlistable) return "Save lead";
  if (canConnect) return "Send request";
  return "View profile";
}
