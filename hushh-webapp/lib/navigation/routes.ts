/**
 * Central route contract for the web + Capacitor app.
 * Keep every app-level navigation target here to avoid drift.
 */

export const ROUTES = {
  HOME: "/",
  DEVELOPERS: "/developers",
  LOGIN: "/login",
  LOGOUT: "/logout",
  LABS_PROFILE_APPEARANCE: "/labs/profile-appearance",
  PROFILE: "/profile",
  PROFILE_PKM: "/profile/pkm",
  PROFILE_PKM_AGENT_LAB: "/profile/pkm-agent-lab",
  PROFILE_RECEIPTS: "/profile/receipts",
  PROFILE_GMAIL_OAUTH_RETURN: "/profile/gmail/oauth/return",
  CONSENTS: "/consents",
  MARKETPLACE: "/marketplace",
  MARKETPLACE_CONNECTIONS: "/marketplace/connections",
  MARKETPLACE_RIA_PROFILE: "/marketplace/ria",
  RIA_HOME: "/ria",
  RIA_ONBOARDING: "/ria/onboarding",
  RIA_CLIENTS: "/ria/clients",
  RIA_WORKSPACE: "/ria/workspace",
  RIA_REQUESTS: "/ria/requests",
  RIA_PICKS: "/ria/picks",
  RIA_SETTINGS: "/ria/settings",
  KAI_HOME: "/kai",
  KAI_ONBOARDING: "/kai/onboarding",
  KAI_IMPORT: "/kai/import",
  KAI_PLAID_OAUTH_RETURN: "/kai/plaid/oauth/return",
  KAI_ALPACA_OAUTH_RETURN: "/kai/alpaca/oauth/return",
  KAI_PORTFOLIO: "/kai/portfolio",
  KAI_INVESTMENTS: "/kai/investments",
  KAI_DASHBOARD: "/kai/portfolio",
  KAI_ANALYSIS: "/kai/analysis",
  KAI_OPTIMIZE: "/kai/optimize",
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

export function buildMarketplaceConnectionsRoute(entries?: {
  tab?: "pending" | "active" | "previous" | null;
  selected?: string | null;
}) {
  return withQuery(ROUTES.CONSENTS, {
    tab: entries?.tab,
    selected: entries?.selected,
  });
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

export function isKaiOnboardingRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.KAI_ONBOARDING ||
    pathname.startsWith(`${ROUTES.KAI_ONBOARDING}/`)
  );
}

export function isPublicRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.LOGIN ||
    pathname === ROUTES.LOGOUT ||
    pathname === ROUTES.PROFILE
  );
}

export function isRiaRoute(pathname: string): boolean {
  return pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`);
}
