import { NextResponse } from "next/server";

// ─── Type Definitions ────────────────────────────────────────────────────────

type ServiceStatus = "Active" | "Pending" | "Revoked";
type PermissionState = "On" | "Off";
type AccessResult =
  | "Authorized"
  | "BLOCKED_BY_CONSENT"
  | "Denied"
  | "Rate_Limited";

interface ConnectedService {
  id: string;
  name: string;
  icon: string;
  status: ServiceStatus;
  connectedAt: string;
  scopes: string[];
  lastSync: string;
}

interface Permission {
  id: string;
  category: string;
  label: string;
  description: string;
  state: PermissionState;
  lastModified: string;
}

interface AccessLog {
  id: string;
  timestamp: string;
  service: string;
  action: string;
  resource: string;
  result: AccessResult;
  ip: string;
}

interface TrustDataResponse {
  user: {
    id: string;
    email: string;
    trustScore: number;
  };
  connected_services: ConnectedService[];
  permissions: Permission[];
  access_logs: AccessLog[];
  metadata: {
    generatedAt: string;
    version: string;
  };
}

// ─── Mock Data (Development) ────────────────────────────────────────────────

const mockData: TrustDataResponse = {
  user: {
    id: "dev-user-123",
    email: "developer@hussh.io",
    trustScore: 87,
  },
  connected_services: [
    {
      id: "service-1",
      name: "Google",
      icon: "🔍",
      status: "Active",
      connectedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["email", "profile", "calendar"],
      lastSync: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "service-2",
      name: "GitHub",
      icon: "🐙",
      status: "Active",
      connectedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["repo", "user:email"],
      lastSync: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "service-3",
      name: "Salesforce",
      icon: "☁️",
      status: "Active",
      connectedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["api", "data"],
      lastSync: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "service-4",
      name: "Slack",
      icon: "💬",
      status: "Pending",
      connectedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["chat:read", "users:read"],
      lastSync: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "service-5",
      name: "Microsoft 365",
      icon: "📊",
      status: "Active",
      connectedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["mail:read", "calendar:read"],
      lastSync: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "service-6",
      name: "Notion",
      icon: "📝",
      status: "Revoked",
      connectedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ["database", "page"],
      lastSync: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  permissions: [
    {
      id: "perm-1",
      category: "Data Sharing",
      label: "Share with Third-party Analytics",
      description: "Allow usage analytics to be shared with external services",
      state: "On",
      lastModified: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-2",
      category: "Data Sharing",
      label: "Marketing Communications",
      description: "Receive promotional emails and offers",
      state: "Off",
      lastModified: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-3",
      category: "Notifications",
      label: "Push Notifications",
      description: "Receive real-time push notifications to mobile device",
      state: "On",
      lastModified: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-4",
      category: "Notifications",
      label: "Email Digest",
      description: "Weekly digest of account activity and recommendations",
      state: "On",
      lastModified: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-5",
      category: "Security",
      label: "Two-Factor Authentication",
      description: "Require 2FA on account access",
      state: "On",
      lastModified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-6",
      category: "Security",
      label: "Geographic Restrictions",
      description: "Restrict access to specific regions",
      state: "Off",
      lastModified: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-7",
      category: "Privacy",
      label: "Data Retention",
      description: "Delete personal data after 12 months of inactivity",
      state: "On",
      lastModified: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "perm-8",
      category: "Privacy",
      label: "GDPR Compliance",
      description: "Enforce GDPR data handling requirements",
      state: "On",
      lastModified: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  access_logs: [
    {
      id: "log-1",
      timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      service: "Google",
      action: "READ",
      resource: "Calendar Events",
      result: "Authorized",
      ip: "192.168.1.101",
    },
    {
      id: "log-2",
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      service: "GitHub",
      action: "WRITE",
      resource: "Repository Settings",
      result: "Authorized",
      ip: "203.45.67.89",
    },
    {
      id: "log-3",
      timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      service: "Salesforce",
      action: "DELETE",
      resource: "Lead Records",
      result: "BLOCKED_BY_CONSENT",
      ip: "145.23.89.12",
    },
    {
      id: "log-4",
      timestamp: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      service: "Microsoft 365",
      action: "READ",
      resource: "Email Inbox",
      result: "Authorized",
      ip: "192.168.1.101",
    },
    {
      id: "log-5",
      timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      service: "Slack",
      action: "WRITE",
      resource: "Channel Message",
      result: "Denied",
      ip: "78.123.45.67",
    },
    {
      id: "log-6",
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      service: "Google",
      action: "MODIFY",
      resource: "Account Settings",
      result: "Authorized",
      ip: "192.168.1.101",
    },
    {
      id: "log-7",
      timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      service: "GitHub",
      action: "READ",
      resource: "Repository Contents",
      result: "Authorized",
      ip: "203.45.67.89",
    },
    {
      id: "log-8",
      timestamp: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
      service: "Salesforce",
      action: "READ",
      resource: "Contact Records",
      result: "Rate_Limited",
      ip: "145.23.89.12",
    },
    {
      id: "log-9",
      timestamp: new Date(Date.now() - 180 * 60 * 1000).toISOString(),
      service: "Microsoft 365",
      action: "DELETE",
      resource: "Calendar Event",
      result: "Denied",
      ip: "210.56.78.90",
    },
    {
      id: "log-10",
      timestamp: new Date(Date.now() - 240 * 60 * 1000).toISOString(),
      service: "Notion",
      action: "READ",
      resource: "Database Pages",
      result: "Authorized",
      ip: "192.168.1.105",
    },
  ],
  metadata: {
    generatedAt: new Date().toISOString(),
    version: "1.0.0",
  },
};

// ─── GET Handler ─────────────────────────────────────────────────────────────
// Returns mock trust data for the privacy dashboard.
// In production, replace with actual database queries.

export async function GET(): Promise<NextResponse<TrustDataResponse | { error: string }>> {
  try {
    // Simulate realistic latency
    await new Promise((resolve) => setTimeout(resolve, 120));

    return NextResponse.json(mockData, { status: 200 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    console.error("[trust-data] GET failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
