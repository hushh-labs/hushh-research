export type ConsentEventType = "granted" | "revoked" | "updated" | "expired";

export interface ConsentEvent {
  id: string;
  type: ConsentEventType;
  permission: string;
  source: string;
  actor: string;
  timestamp: string;
  description: string;
}

export const consentEvents: ConsentEvent[] = [
  {
    id: "1",
    type: "granted",
    permission: "Portfolio Valuation Access",
    source: "Wallet",
    actor: "User",
    timestamp: "Today, 10:45 AM",
    description: "User granted permission to access portfolio valuation data.",
  },
  {
    id: "2",
    type: "updated",
    permission: "Analytics Scope",
    source: "Dashboard",
    actor: "User",
    timestamp: "Today, 09:20 AM",
    description: "Consent scope was updated for analytics-based recommendations.",
  },
  {
    id: "3",
    type: "revoked",
    permission: "Export Permission",
    source: "Privacy Center",
    actor: "User",
    timestamp: "Yesterday, 06:10 PM",
    description: "User revoked permission for exporting consent-linked reports.",
  },
  {
    id: "4",
    type: "expired",
    permission: "Third-party Data Access",
    source: "Auto Expiry",
    actor: "System",
    timestamp: "Apr 27, 2026",
    description: "Permission expired automatically based on consent duration.",
  },
];