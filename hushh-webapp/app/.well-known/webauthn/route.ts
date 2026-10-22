import { NextRequest, NextResponse } from "next/server";
import domainAliases from "@/lib/vault/passkey-domain-aliases.json";

export const dynamic = "force-dynamic";

/** Each RP authorizes its own environment's spelling alias, never another lane. */
export async function GET(request: NextRequest) {
  const hosts = Object.entries(domainAliases).find(
    ([lane]) => lane === process.env.HUSHH_DEPLOY_ENV,
  )?.[1];
  // Cloud Run preserves the external Host; do not trust x-forwarded-host.
  const host = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  if (!hosts?.includes(host)) {
    return NextResponse.json(
      { error: "Passkey origin is not configured." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { origins: hosts.map((hostname) => `https://${hostname}`) },
    { headers: { "Cache-Control": "public, max-age=300", Vary: "Host" } },
  );
}
