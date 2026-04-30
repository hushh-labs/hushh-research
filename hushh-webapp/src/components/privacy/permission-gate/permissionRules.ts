export type SensitivePermission =
  | "portfolio_valuation"
  | "export_report"
  | "analytics_insights";

export interface PermissionRule {
  permission: SensitivePermission;
  label: string;
  description: string;
}

export const permissionRules: Record<SensitivePermission, PermissionRule> = {
  portfolio_valuation: {
    permission: "portfolio_valuation",
    label: "Portfolio Valuation",
    description:
      "Nav requires explicit permission before portfolio valuation data can be accessed.",
  },
  export_report: {
    permission: "export_report",
    label: "Report Export",
    description:
      "Nav requires explicit permission before exporting consent-linked reports.",
  },
  analytics_insights: {
    permission: "analytics_insights",
    label: "Analytics Insights",
    description:
      "Nav requires explicit permission before viewing analytics-based recommendations.",
  },
};