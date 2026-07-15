import { NextRequest, NextResponse } from "next/server";

import { sanitizePortfolioSharePayload } from "@/lib/portfolio-share/contract";
import { createPortfolioShareToken } from "@/lib/portfolio-share/token";

function pickForwardedHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

function resolvePublicAppBaseUrl(request: NextRequest): string {
  const configuredBaseUrl =
    (process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (configuredBaseUrl) return configuredBaseUrl;

  const forwardedProto = pickForwardedHeaderValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = pickForwardedHeaderValue(request.headers.get("x-forwarded-host"));
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const host = request.headers.get("host")?.trim();
  if (host) {
    const protocol = request.nextUrl.protocol || "https:";
    return `${protocol}//${host}`.replace(/\/$/, "");
  }

  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as
      | {
          payload?: unknown;
        }
      | null;

    if (!body?.payload) {
      return NextResponse.json({ error: "payload is required" }, { status: 400 });
    }

    const payload = sanitizePortfolioSharePayload(body.payload);
    const hasUsefulData =
      payload.portfolioValue > 0 ||
      payload.topHoldings.length > 0 ||
      payload.allocationMix.length > 0 ||
      payload.sectorAllocation.length > 0 ||
      payload.performance.length > 0;

    if (!hasUsefulData) {
      return NextResponse.json(
        { error: "payload must include at least one non-empty portfolio metric" },
        { status: 400 }
      );
    }

    const { token, expiresAt } = await createPortfolioShareToken(payload);
    const publicBaseUrl = resolvePublicAppBaseUrl(request);
    const url = `${publicBaseUrl}/portfolio/shared?token=${encodeURIComponent(token)}`;

    return NextResponse.json({ url, expiresAt }, { status: 200 });
  } catch (error) {
    console.error("[PortfolioShare] Failed to create share link:", error);
    return NextResponse.json({ error: "failed to create share link" }, { status: 500 });
  }
}
