import { NextResponse } from "next/server";
import { ROUTES } from "@/lib/navigation/routes";

export const dynamic = "force-dynamic";

function resolveAssociatedAppId(): string | null {
  const teamId =
    process.env.APPLE_TEAM_ID ||
    process.env.NEXT_PUBLIC_APPLE_TEAM_ID ||
    "";
  const bundleId = process.env.NEXT_PUBLIC_IOS_BUNDLE_ID || "com.hushh.app";
  if (!teamId.trim() || !bundleId.trim()) {
    return null;
  }
  return `${teamId.trim()}.${bundleId.trim()}`;
}

export async function GET() {
  const appId = resolveAssociatedAppId();
  if (!appId) {
    return NextResponse.json(
      {
        error:
          "Missing passkey domain association config. Set APPLE_TEAM_ID (or NEXT_PUBLIC_APPLE_TEAM_ID) and NEXT_PUBLIC_IOS_BUNDLE_ID.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
      }
    );
  }

  return NextResponse.json(
    {
      applinks: {
        apps: [],
        details: [{ appID: appId, paths: [ROUTES.PROFILE_GOOGLE_OAUTH_RETURN, `${ROUTES.PROFILE_GOOGLE_OAUTH_RETURN}/`] }],
      },
      webcredentials: {
        apps: [appId],
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/json",
      },
    }
  );
}
