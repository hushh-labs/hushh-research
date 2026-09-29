import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Paths iOS should hand back to the app instead of Safari.
 *
 * OAuth returns and shared invitations belong inside an installed app.
 * Before this list existed
 * the applinks block was empty, so iOS had nothing to match and opened the
 * browser, which is exactly what a person saw after connecting a bank account.
 *
 * Adding a path here is half the claim. The app must also declare
 * `applinks:<domain>` in its entitlements, or iOS never asks for this file.
 */
const OAUTH_LINK_PATHS = [
  "/one/kai/plaid/oauth/return",
  "/one/profile/google/oauth/return",
  "/one/profile/gmail/oauth/return",
  "/one/profile/connectors/oauth/return",
  "/kai/plaid/oauth/return",
  "/profile/google/oauth/return",
  "/profile/gmail/oauth/return",
] as const;

export const INVITATION_LINK_PATHS = [
  "/",
  "/circle/join",
  "/circle/join/",
  "/one/location/invite/*",
] as const;

export const UNIVERSAL_LINK_PATHS = [...OAUTH_LINK_PATHS, ...INVITATION_LINK_PATHS] as const;

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
  // Old installed iOS bundles cannot render arbitrary invite tokens. Activate
  // the expanded claim only after the matching native bundle is distributed.
  // Until then, shared links keep opening the web introduction, not a broken app.
  const paths = process.env.NATIVE_INVITATION_LINKS_ENABLED === "true"
    ? UNIVERSAL_LINK_PATHS
    : OAUTH_LINK_PATHS;
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
            // provider returns and invitation entry points are claimed.
            components: paths.map((path) => ({
              "/": path,
              comment: `Open the matching One screen (${path})`,
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
