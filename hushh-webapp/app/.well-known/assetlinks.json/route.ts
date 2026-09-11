import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function resolveSha256Fingerprints(): string[] {
  const raw = process.env.ANDROID_SHA256_CERT_FINGERPRINTS || "";
  return raw
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

export async function GET() {
  const packageName = process.env.NEXT_PUBLIC_ANDROID_APP_ID;
  const fingerprints = resolveSha256Fingerprints();

  // No fallback to a hardcoded package name here: a stale default that
  // silently diverges from the real Android application id (as happened
  // across the com.hushh.app -> com.hussh.app rename) would authorize the
  // WRONG app for passkey credential delegation without ever surfacing an
  // error -- fail loudly instead, matching the missing-fingerprints case
  // below.
  if (!packageName) {
    return NextResponse.json(
      {
        error:
          "Missing NEXT_PUBLIC_ANDROID_APP_ID for passkey domain association.",
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

  if (!fingerprints.length) {
    return NextResponse.json(
      {
        error:
          "Missing ANDROID_SHA256_CERT_FINGERPRINTS for passkey domain association.",
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
    [
      {
        relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ],
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/json",
      },
    }
  );
}
