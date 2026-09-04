import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Paths iOS should hand back to the app instead of Safari.
 *
 * Every entry is an OAuth-style return: the person left for Plaid, Alpaca,
 * Google or Gmail and must land back inside the app. Before this list existed
 * the applinks block was empty, so iOS had nothing to match and opened the
 * browser, which is exactly what a person saw after connecting a bank account.
 *
 * Adding a path here is half the claim. The app must also declare
 * `applinks:<domain>` in its entitlements, or iOS never asks for this file.
 */
export const UNIVERSAL_LINK_PATHS = [
  "/one/kai/plaid/oauth/return",
  "/one/kai/alpaca/oauth/return",
  "/one/profile/google/oauth/return",
  "/one/profile/gmail/oauth/return",
  "/kai/plaid/oauth/return",
  "/kai/alpaca/oauth/return",
  "/profile/google/oauth/return",
  "/profile/gmail/oauth/return",
] as const;

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
        details: [
          {
            appIDs: [appId],
            // Deliberately narrow. Claiming "*" would route every link to this
            // domain into the app, including public consent links, share pages
            // and marketing, which is a worse bug than the one this fixes. Only
            // the paths a person must be returned to after leaving for a
            // provider are claimed.
            components: UNIVERSAL_LINK_PATHS.map((path) => ({
              "/": path,
              comment: `Return into the app after an external provider flow (${path})`,
            })),
          },
        ],
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
