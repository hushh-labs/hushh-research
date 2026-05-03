/**
 * Central route contract for the web + Capacitor app.
 * Keep every app-level navigation target here to avoid drift.
 */

export const ROUTES = {
  HOME: "/",
  LOGIN: "/login",
  LOGOUT: "/logout",
  LABS_PROFILE_APPEARANCE: "/labs/profile-appearance",
  PROFILE: "/profile",
  CONSENTS: "/consents",
  MARKETPLACE: "/marketplace",
  MARKETPLACE_RIA_PROFILE: "/marketplace/ria",
  RIA_HOME: "/ria",
  RIA_ONBOARDING: "/ria/onboarding",
  RIA_CLIENTS: "/ria/clients",
  RIA_REQUESTS: "/ria/requests",
  RIA_PICKS: "/ria/picks",
  RIA_SETTINGS: "/ria/settings",
  KAI_HOME: "/kai",
  KAI_ONBOARDING: "/kai/onboarding",
  KAI_IMPORT: "/kai/import",
  KAI_PLAID_OAUTH_RETURN: "/kai/plaid/oauth/return",
  KAI_PORTFOLIO: "/kai/portfolio",
  KAI_INVESTMENTS: "/kai/investments",
  KAI_DASHBOARD: "/kai/portfolio",
  KAI_ANALYSIS: "/kai/analysis",
  KAI_OPTIMIZE: "/kai/optimize",
  IALPHABETS_HOME: "/ialphabets",
  IALPHABETS_LEAGUES: "/ialphabets/leagues",
  IALPHABETS_DRAFT: "/ialphabets/draft",
  IALPHABETS_JOIN: "/ialphabets/join",
  IALPHABETS_DISCOVER: "/ialphabets/discover",
  IALPHABETS_SHARE: "/ialphabets/share",
} as const;

export function isKaiOnboardingRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.KAI_ONBOARDING ||
    pathname.startsWith(`${ROUTES.KAI_ONBOARDING}/`)
  );
}

export function isPublicRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.LOGIN ||
    pathname === ROUTES.LOGOUT ||
    pathname === ROUTES.PROFILE
  );
}

export function isIalphabetsRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.IALPHABETS_HOME ||
    pathname.startsWith(`${ROUTES.IALPHABETS_HOME}/`)
  );
}

export function isRiaRoute(pathname: string): boolean {
  return pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`);
}
