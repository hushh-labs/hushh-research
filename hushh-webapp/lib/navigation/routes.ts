/**
 * Central route contract for the web + Capacitor app.
 * Keep every app-level navigation target here to avoid drift.
 */

export const ROUTES = {
  HOME: "/",
  ONE_HOME: "/one",
  DEVELOPERS: "/developers",
  LOGIN: "/login",
  LOGOUT: "/logout",
  PHONE_MANDATE: "/register-phone",
  LABS_PROFILE_APPEARANCE: "/labs/profile-appearance",
  PROFILE: "/profile",
  PROFILE_PKM: "/profile/pkm",
  PROFILE_PKM_AGENT_LAB: "/profile/pkm-agent-lab",
  PROFILE_RECEIPTS: "/profile/receipts",
  PROFILE_GMAIL_OAUTH_RETURN: "/profile/gmail/oauth/return",
  ONE_ONBOARDING: "/one/onboarding",
  GMAIL: "/one/gmail",
  PKM: "/one/pkm",
  CONNECTED_SYSTEMS: "/one/connected-systems",
  CONSENTS: "/consents",
  AGENT: "/agent",
  MARKETPLACE: "/marketplace",
  MARKETPLACE_CONNECTIONS: "/marketplace/connections",
  MARKETPLACE_RIA_PROFILE: "/marketplace/ria",
  ONE_KYC: "/one/kyc",
  ONE_LOCATION: "/one/location",
  LEGACY_GMAIL: "/gmail",
  LEGACY_PKM: "/pkm",
  LEGACY_CONNECTED_SYSTEMS: "/connected-systems",
  LEGACY_KAI_HOME: "/kai",
  LEGACY_KAI_ONBOARDING: "/kai/onboarding",
  LEGACY_ONE_KAI_ONBOARDING: "/one/kai/onboarding",
  LEGACY_KAI_IMPORT: "/kai/import",
  LEGACY_KAI_PLAID_OAUTH_RETURN: "/kai/plaid/oauth/return",
  LEGACY_KAI_ALPACA_OAUTH_RETURN: "/kai/alpaca/oauth/return",
  LEGACY_KAI_PORTFOLIO: "/kai/portfolio",
  LEGACY_KAI_INVESTMENTS: "/kai/investments",
  LEGACY_KAI_FUNDING_TRADE: "/kai/funding-trade",
  LEGACY_KAI_ANALYSIS: "/kai/analysis",
  LEGACY_KAI_OPTIMIZE: "/kai/optimize",
  RIA_HOME: "/ria",
  RIA_ONBOARDING: "/ria/onboarding",
  RIA_CLIENTS: "/ria/clients",
  RIA_WORKSPACE: "/ria/workspace",
  RIA_REQUESTS: "/ria/requests",
  RIA_PICKS: "/ria/picks",
  RIA_SETTINGS: "/ria/settings",
  KAI_HOME: "/one/kai",
  KAI_ONBOARDING: "/one/onboarding",
  KAI_IMPORT: "/one/kai/import",
  KAI_PLAID_OAUTH_RETURN: "/one/kai/plaid/oauth/return",
  KAI_ALPACA_OAUTH_RETURN: "/one/kai/alpaca/oauth/return",
  KAI_PORTFOLIO: "/one/kai/portfolio",
  KAI_INVESTMENTS: "/one/kai/investments",
  KAI_FUNDING_TRADE: "/one/kai/funding-trade",
  KAI_DASHBOARD: "/one/kai/portfolio",
  KAI_ANALYSIS: "/one/kai/analysis",
  KAI_OPTIMIZE: "/one/kai/optimize",
} as const;

function withQuery(pathname: string, entries: Record<string, string | null | undefined>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(entries)) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      params.set(key, normalized);
    }
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildMarketplaceRiaProfileRoute(riaId?: string | null) {
  return withQuery(ROUTES.MARKETPLACE_RIA_PROFILE, { riaId });
}

export function buildPhoneMandateRoute(redirect?: string | null) {
  return withQuery(ROUTES.PHONE_MANDATE, { redirect });
}

export function normalizeInternalRouteHref(value: string | null | undefined): string | null {
  const href = String(value ?? "").trim();
  if (!href) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (/[\r\n]/.test(href)) return null;
  return href;
}

export function resolveInternalRouteHref(
  value: string | null | undefined,
  fallback: string,
): string {
  return normalizeInternalRouteHref(value) ?? fallback;
}

export function buildOneOnboardingRoute(entries?: {
  from?: string | null;
  invite?: string | null;
}) {
  return withQuery(ROUTES.ONE_ONBOARDING, {
    from: normalizeInternalRouteHref(entries?.from),
    invite: entries?.invite,
  });
}

export const buildKaiOnboardingRoute = buildOneOnboardingRoute;

export function buildProfileVaultRoute(returnTo?: string | null) {
  return withQuery(ROUTES.PROFILE, {
    panel: "security",
    unlock_vault: "1",
    return_to: returnTo,
  });
}

export function buildMarketplaceConnectionsRoute(entries?: {
  tab?: "pending" | "active" | "previous" | null;
  selected?: string | null;
}) {
  return withQuery(ROUTES.CONSENTS, {
    tab: entries?.tab,
    requestId: entries?.selected,
  });
}

export function buildConnectedSystemRoute(systemId?: string | null) {
  const normalized = String(systemId ?? "").trim();
  if (!normalized) return ROUTES.CONNECTED_SYSTEMS;
  return `${ROUTES.CONNECTED_SYSTEMS}/${encodeURIComponent(normalized)}`;
}

export function buildMarketplaceConnectionPortfolioRoute(connectionId?: string | null) {
  const normalized = String(connectionId ?? "").trim();
  if (!normalized) return ROUTES.RIA_CLIENTS;
  return buildRiaClientWorkspaceRoute(normalized, { tab: "kai" });
}

export function buildRiaClientWorkspaceRoute(
  clientId?: string | null,
  entries?: {
    tab?: "overview" | "access" | "kai" | "explorer" | null;
    testProfile?: boolean | null;
  }
) {
  const normalized = String(clientId ?? "").trim();
  if (!normalized) return ROUTES.RIA_CLIENTS;
  return withQuery(`${ROUTES.RIA_CLIENTS}/${encodeURIComponent(normalized)}`, {
    tab: entries?.tab,
    test_profile: entries?.testProfile ? "1" : null,
  });
}

export function buildRiaClientAccountRoute(
  clientId?: string | null,
  accountId?: string | null,
  entries?: {
    testProfile?: boolean | null;
  }
) {
  const normalizedClientId = String(clientId ?? "").trim();
  const normalizedAccountId = String(accountId ?? "").trim();
  if (!normalizedClientId || !normalizedAccountId) return ROUTES.RIA_CLIENTS;
  return withQuery(
    `${ROUTES.RIA_CLIENTS}/${encodeURIComponent(normalizedClientId)}/accounts/${encodeURIComponent(
      normalizedAccountId
    )}`,
    {
      test_profile: entries?.testProfile ? "1" : null,
    }
  );
}

export function buildRiaClientRequestRoute(
  clientId?: string | null,
  requestId?: string | null,
  entries?: {
    testProfile?: boolean | null;
  }
) {
  const normalizedClientId = String(clientId ?? "").trim();
  const normalizedRequestId = String(requestId ?? "").trim();
  if (!normalizedClientId || !normalizedRequestId) return ROUTES.RIA_CLIENTS;
  return withQuery(
    `${ROUTES.RIA_CLIENTS}/${encodeURIComponent(normalizedClientId)}/requests/${encodeURIComponent(
      normalizedRequestId
    )}`,
    {
      test_profile: entries?.testProfile ? "1" : null,
    }
  );
}

export function buildRiaWorkspaceRoute(
  clientId?: string | null,
  entries?: {
    tab?: "overview" | "access" | "kai" | "explorer" | null;
    testProfile?: boolean | null;
  }
) {
  return buildRiaClientWorkspaceRoute(clientId, entries);
}

export function buildKaiAnalysisPreviewRoute(entries?: {
  ticker?: string | null;
  pickSource?: string | null;
}) {
  return withQuery(ROUTES.KAI_ANALYSIS, {
    ticker: entries?.ticker,
    pick_source: entries?.pickSource,
  });
}

export function isOneOnboardingRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.ONE_ONBOARDING ||
    pathname.startsWith(`${ROUTES.ONE_ONBOARDING}/`) ||
    pathname === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||
    pathname.startsWith(`${ROUTES.LEGACY_ONE_KAI_ONBOARDING}/`) ||
    pathname === ROUTES.LEGACY_KAI_ONBOARDING ||
    pathname.startsWith(`${ROUTES.LEGACY_KAI_ONBOARDING}/`)
  );
}

export const isKaiOnboardingRoute = isOneOnboardingRoute;

export function isPublicRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.LOGIN ||
    pathname === ROUTES.PHONE_MANDATE ||
    pathname === ROUTES.LOGOUT ||
    pathname === ROUTES.PROFILE ||
    pathname.startsWith(`${ROUTES.ONE_LOCATION}/request/`)
  );
}

export function isRiaRoute(pathname: string): boolean {
  return pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`);
}

export function isRiaOnboardingRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.RIA_ONBOARDING ||
    pathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`)
  );
}

export function isRiaActionBarRoute(pathname: string | null | undefined): boolean {
  const path = pathname ?? "";
  return isRiaRoute(path) && !isRiaOnboardingRoute(path);
}
