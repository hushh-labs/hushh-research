export type SensitivePermission = "portfolio_valuation";

export interface PermissionRule {
  permission: SensitivePermission;
  eyebrow: string;
  title: string;
  description: string;
}

export const permissionRules: Record<SensitivePermission, PermissionRule> = {
  portfolio_valuation: {
    permission: "portfolio_valuation",
    eyebrow: "Nav privacy guard",
    title: "Vault permission required",
    description:
      "Unlock your vault and review consent before Kai uses portfolio data for personalized market context.",
  },
};
