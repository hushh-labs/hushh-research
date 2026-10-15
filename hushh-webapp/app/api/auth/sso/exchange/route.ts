import { NextRequest } from "next/server";
import { proxyEnterpriseSso } from "@/app/api/_utils/enterprise-sso-proxy";

export async function POST(request: NextRequest) {
  return proxyEnterpriseSso("/api/auth/sso/exchange", {
    method: "POST",
    body: await request.text(),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
}
