import { NextRequest } from "next/server";
import { proxyEnterpriseSso } from "@/app/api/_utils/enterprise-sso-proxy";

export async function GET(request: NextRequest) {
  return proxyEnterpriseSso("/api/auth/sso/start", {
    method: "GET",
    search: request.nextUrl.search,
  });
}
