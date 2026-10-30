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
  const packageName = process.env.NEXT_PUBLIC_ANDROID_APP_ID || "com.hushh.app";
  const fingerprints = resolveSha256Fingerprints();

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
        relation: ["delegate_permission/common.get_login_creds"],
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
