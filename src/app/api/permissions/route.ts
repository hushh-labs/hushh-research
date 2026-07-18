import { NextRequest, NextResponse } from "next/server";

// ─── In-Memory Permission State (Development) ────────────────────────────────

const permissionStates: Record<string, "On" | "Off"> = {
  "perm-1": "On",
  "perm-2": "Off",
  "perm-3": "On",
  "perm-4": "On",
  "perm-5": "On",
  "perm-6": "Off",
  "perm-7": "On",
  "perm-8": "On",
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface UpdatePermissionRequest {
  permissionId: string;
  newState: "On" | "Off";
}

interface UpdatePermissionResponse {
  id: string;
  category: string;
  label: string;
  description: string;
  state: "On" | "Off";
  lastModified: string;
}

// ─── Mock Permission Data ───────────────────────────────────────────────────

const permissionMetadata: Record<string, Omit<UpdatePermissionResponse, "state" | "lastModified">> = {
  "perm-1": {
    id: "perm-1",
    category: "Data Sharing",
    label: "Share with Third-party Analytics",
    description: "Allow usage analytics to be shared with external services",
  },
  "perm-2": {
    id: "perm-2",
    category: "Data Sharing",
    label: "Marketing Communications",
    description: "Receive promotional emails and offers",
  },
  "perm-3": {
    id: "perm-3",
    category: "Notifications",
    label: "Push Notifications",
    description: "Receive real-time push notifications to mobile device",
  },
  "perm-4": {
    id: "perm-4",
    category: "Notifications",
    label: "Email Digest",
    description: "Weekly digest of account activity and recommendations",
  },
  "perm-5": {
    id: "perm-5",
    category: "Security",
    label: "Two-Factor Authentication",
    description: "Require 2FA on account access",
  },
  "perm-6": {
    id: "perm-6",
    category: "Security",
    label: "Geographic Restrictions",
    description: "Restrict access to specific regions",
  },
  "perm-7": {
    id: "perm-7",
    category: "Privacy",
    label: "Data Retention",
    description: "Delete personal data after 12 months of inactivity",
  },
  "perm-8": {
    id: "perm-8",
    category: "Privacy",
    label: "GDPR Compliance",
    description: "Enforce GDPR data handling requirements",
  },
};

// ─── PATCH Handler ──────────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest
): Promise<NextResponse<UpdatePermissionResponse | { error: string }>> {
  try {
    // Parse request body
    const body: UpdatePermissionRequest = await req.json();

    // Validate input
    if (!body.permissionId || !body.newState) {
      return NextResponse.json(
        { error: "Missing required fields: permissionId and newState" },
        { status: 400 }
      );
    }

    if (!["On", "Off"].includes(body.newState)) {
      return NextResponse.json(
        { error: "Invalid newState. Must be 'On' or 'Off'" },
        { status: 400 }
      );
    }

    // Check if permission exists in mock data
    if (!permissionMetadata[body.permissionId]) {
      return NextResponse.json(
        { error: `Permission with id '${body.permissionId}' not found` },
        { status: 404 }
      );
    }

    // Update the permission state in memory
    permissionStates[body.permissionId] = body.newState;

    // Return formatted response
    const response: UpdatePermissionResponse = {
      ...permissionMetadata[body.permissionId],
      state: body.newState,
      lastModified: new Date().toISOString(),
    };

    console.log(`[permissions] Updated permission ${body.permissionId} to ${body.newState}`);

    return NextResponse.json(response, { status: 200 });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred";

    console.error("[permissions] PATCH failed:", message);

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
