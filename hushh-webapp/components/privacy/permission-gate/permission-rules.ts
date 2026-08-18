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
    title: "Lock required",
    description:
      "Unlock and review consent before Kai uses portfolio information for personalized market context.",
  },
};
