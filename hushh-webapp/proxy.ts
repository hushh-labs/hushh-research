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
];

// API routes are handled separately
const API_PREFIX = "/api";
const LEGACY_PROFILE_ROOT = "/profile";
const LEGACY_CONNECT_ROOT = "/connect";

const LEGACY_ROUTE_REDIRECTS: Record<string, string> = {
  [ROUTES.LEGACY_KAI_HOME]: ROUTES.KAI_HOME,
  [ROUTES.LEGACY_ONE_KAI_MARKET]: ROUTES.KAI_HOME,
  [ROUTES.LEGACY_KAI_ANALYSIS]: ROUTES.KAI_ANALYSIS,
  [ROUTES.LEGACY_KAI_IMPORT]: ROUTES.KAI_IMPORT,
  "/kai/investments": ROUTES.KAI_PORTFOLIO,
  "/one/kai/investments": ROUTES.KAI_PORTFOLIO,
  "/kai/funding-trade": ROUTES.KAI_PORTFOLIO,
  "/one/kai/funding-trade": ROUTES.KAI_PORTFOLIO,
  [ROUTES.LEGACY_KAI_ONBOARDING]: ROUTES.ONE_SETUP_FINANCE,
  [ROUTES.LEGACY_ONE_KAI_ONBOARDING]: ROUTES.ONE_SETUP_FINANCE,
  [ROUTES.ONE_SETUP_KAI]: ROUTES.ONE_SETUP_FINANCE,
  [ROUTES.LEGACY_KAI_OPTIMIZE_COMPAT]: ROUTES.KAI_PORTFOLIO,
  [ROUTES.LEGACY_KAI_PORTFOLIO]: ROUTES.KAI_PORTFOLIO,
  [ROUTES.LEGACY_KAI_PLAID_OAUTH_RETURN]: ROUTES.KAI_PLAID_OAUTH_RETURN,
  [ROUTES.LEGACY_KAI_ALPACA_OAUTH_RETURN]: ROUTES.KAI_ALPACA_OAUTH_RETURN,
  "/kai/dashboard": ROUTES.KAI_DASHBOARD,
  "/kai/dashboard/analysis": ROUTES.KAI_ANALYSIS,
  "/one/kai/portfolio": ROUTES.KAI_PORTFOLIO,
  "/one/kai/analysis": ROUTES.KAI_ANALYSIS,
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host") || "";

  const legacyHostTargets: Record<string, string> = {
    "uat.kai.hushh.ai": "uat.one.hushh.ai",
    "dev.kai.hushh.ai": "dev.one.hushh.ai",
    "kai.hushh.ai": "one.hushh.ai",
  };
  const legacyHostTarget = legacyHostTargets[host];
  if (legacyHostTarget) {
    const url = request.nextUrl.clone();
    url.host = legacyHostTarget;
    url.protocol = "https:";
    return NextResponse.redirect(url, 301);
  }

  const legacyRedirectTarget = LEGACY_ROUTE_REDIRECTS[pathname];
  if (legacyRedirectTarget) {
    const url = request.nextUrl.clone();
    const [targetPath, targetSearch] = legacyRedirectTarget.split("?");
    url.pathname = targetPath;
    if (targetSearch) {
      // The canonical target supplies the default tab, while an explicit
      // legacy query (for example `/kai?tab=portfolio`) always wins.
      const defaults = new URLSearchParams(targetSearch);
      defaults.forEach((value, key) => {
        if (!url.searchParams.has(key)) url.searchParams.set(key, value);
      });
    }
    return NextResponse.redirect(url);
  }

  for (const [legacyRoot, canonicalRoot] of [
    [LEGACY_PROFILE_ROOT, ROUTES.PROFILE],
    [LEGACY_CONNECT_ROOT, ROUTES.CONNECT],
  ] as const) {
    if (pathname !== legacyRoot && !pathname.startsWith(`${legacyRoot}/`)) {
      continue;
    }
    const url = request.nextUrl.clone();
    url.pathname = `${canonicalRoot}${pathname.slice(legacyRoot.length)}`;
    return NextResponse.redirect(url);
  }

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
     * - _next/* (static files, image optimization, and dev HMR websocket)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/|favicon.ico).*)",
  ],
};
