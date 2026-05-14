// proxy.ts
// Next.js 16 Proxy for Route Protection (formerly middleware.ts)

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ROUTES, isPublicRoute } from "./lib/navigation/routes";

// Routes that don't require authentication (VaultLockGuard handles protected routes)
const PUBLIC_ROUTES = [
  ROUTES.HOME,
  ROUTES.DEVELOPERS,
  ROUTES.LOGIN,
  ROUTES.PHONE_MANDATE,
  ROUTES.LOGOUT,
  ROUTES.PROFILE,
];

// API routes are handled separately
const API_PREFIX = "/api";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow all API routes (they handle their own auth)
  if (pathname.startsWith(API_PREFIX)) {
    return NextResponse.next();
  }

  // Allow public routes
  if (PUBLIC_ROUTES.includes(pathname) || isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  // Allow static files and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // =========================================================================
  // IMPORTANT: Firebase Auth is CLIENT-SIDE. We cannot reliably check auth
  // server-side in proxy without session cookies (which we don't use).
  //
  // Auth is handled by:
  // 1. VaultLockGuard in dashboard/consents layouts (checks Firebase auth + vault)
  // 2. KaiOnboardingGuard + PostAuthRouteService (resolve onboarding from
  //    real user/vault/profile state, not stale client cookies)
  // 2. useAuth hook in individual pages
  //
  // The proxy just handles basic routing and allows all requests through.
  // Protected pages will redirect to "/login" if not authenticated.
  // =========================================================================

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
