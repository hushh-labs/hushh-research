import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  
  if (host === "uat.kai.hushh.ai") {
    const url = request.nextUrl.clone();
    url.host = "uat.one.hushh.ai";
    url.protocol = "https:";
    return NextResponse.redirect(url, 301);
  }
  
  if (host === "dev.kai.hushh.ai") {
    const url = request.nextUrl.clone();
    url.host = "dev.one.hushh.ai";
    url.protocol = "https:";
    return NextResponse.redirect(url, 301);
  }
  
  if (host === "kai.hushh.ai") {
    const url = request.nextUrl.clone();
    url.host = "one.hushh.ai";
    url.protocol = "https:";
    return NextResponse.redirect(url, 301);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
