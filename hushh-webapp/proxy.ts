// proxy.ts
// Next.js 16 Proxy for Route Protection (formerly middleware.ts)

import { NextResponse } from "next/server";
import type { NextRequest, NextMiddlewareResult } from "next/server";
import { ROUTES, isPublicRoute } from "./lib/navigation/routes";
import {
  LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX,
  PUBLIC_LOCATION_VIEW_PREFIX,
} from "./lib/one-location/public-invite-url";

// ============================================================================
// Security headers (CS-3 fix, security assessment 2026-08-17)
// ============================================================================
// The app shipped with no Content-Security-Policy and no clickjacking/
// HSTS/MIME-sniffing headers, so nothing in the browser stopped an injected
// script from running or the page from being framed. The CSP uses a
// per-request nonce (Next.js's documented pattern:
// https://nextjs.org/docs/app/guides/content-security-policy) so the app's
// own inline bootstrap/analytics scripts keep working without falling back
// to 'unsafe-inline' on script-src, which would defeat the point.
//
// Only web/Cloud Run builds run this proxy (Capacitor static export does
// not execute it), which matches the live host this was assessed against
// (https://uat.one.hushh.ai).

function buildCsp(nonce: string, isDev: boolean): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      // Next.js dev overlay/HMR needs eval; production never sets this.
      ...(isDev ? ["'unsafe-eval'"] : []),
      "https://www.googletagmanager.com",
      "https://cdn.plaid.com",
    ],
    // style-src cannot execute JS, so 'unsafe-inline' here doesn't defeat the
    // policy the way it would on script-src; kept permissive so component
    // <style> blocks (e.g. chart theming) don't need per-component nonces.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
    "connect-src": [
      "'self'",
      "https://api.hushh.ai",
      "https://api.uat.hushh.ai",
      "https://*.googleapis.com",
      "https://www.google-analytics.com",
      "https://www.googletagmanager.com",
      "https://cdn.plaid.com",
      "https://*.plaid.com",
      ...(isDev ? ["ws:", "http://127.0.0.1:*"] : []),
    ],
    "frame-src": ["'self'", "https://cdn.plaid.com", "https://*.plaid.com"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };

  const policy = Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(" ")}`)
    .join("; ");

  return isDev ? policy : `${policy}; upgrade-insecure-requests`;
}

/** Stamps the CSP + the rest of the security headers onto any response this
 * proxy returns (redirect or pass-through). */
function withSecurityHeaders(
  response: NextMiddlewareResult,
  nonce: string,
): NextMiddlewareResult {
  if (!response) return response;

  const isDev = process.env.NODE_ENV !== "production";

  response.headers.set("Content-Security-Policy", buildCsp(nonce, isDev));
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), interest-cohort=()",
  );
  if (!isDev) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

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

  // CS-3 fix: one nonce per request, forwarded to Server Components (see
  // app/layout.tsx) via the x-nonce request header and bound into the CSP
  // response header below via withSecurityHeaders.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  const next = () =>
    NextResponse.next({ request: { headers: requestHeaders } });

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
    return withSecurityHeaders(NextResponse.redirect(url, 301), nonce);
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
    return withSecurityHeaders(NextResponse.redirect(url), nonce);
  }

  for (const [legacyRoot, canonicalRoot] of [
    [LEGACY_PROFILE_ROOT, ROUTES.PROFILE],
    [LEGACY_CONNECT_ROOT, ROUTES.CONNECT],
    // Public live-location links. The page moved to `/view` because "request"
    // described the submission form this route used to be, not the location it
    // shows — but the old path is already inside messages that were sent, so it
    // redirects rather than 404s. Deliberately a redirect and not a rewrite:
    // the recipient should SEE the honest path once they arrive, which is the
    // whole reason for the rename.
    [LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX, PUBLIC_LOCATION_VIEW_PREFIX],
  ] as const) {
    if (pathname !== legacyRoot && !pathname.startsWith(`${legacyRoot}/`)) {
      continue;
    }
    const url = request.nextUrl.clone();
    url.pathname = `${canonicalRoot}${pathname.slice(legacyRoot.length)}`;
    return withSecurityHeaders(NextResponse.redirect(url), nonce);
  }

  // Allow all API routes (they handle their own auth)
  if (pathname.startsWith(API_PREFIX)) {
    return withSecurityHeaders(next(), nonce);
  }

  // Allow public routes
  if (PUBLIC_ROUTES.includes(pathname) || isPublicRoute(pathname)) {
    return withSecurityHeaders(next(), nonce);
  }

  // Allow static files and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return withSecurityHeaders(next(), nonce);
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

  return withSecurityHeaders(next(), nonce);
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
