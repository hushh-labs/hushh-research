/**
 * Central route contract for the web + Capacitor app.
 * Keep every app-level navigation target here to avoid drift.
 */

export const ROUTES = {
  HOME: "/",
  ONE_HOME: "/one",
  DEVELOPERS: "/developers",
  LOGIN: "/login",
  GETTING_STARTED: "/getting-started",
  LOGOUT: "/logout",
  PHONE_MANDATE: "/register-phone",
  LABS_PROFILE_APPEARANCE: "/labs/profile-appearance",
  PROFILE: "/profile",
  PROFILE_PKM: "/profile/pkm",
  PROFILE_PKM_AGENT_LAB: "/profile/pkm-agent-lab",
  PROFILE_RECEIPTS: "/profile/receipts",
  PROFILE_GMAIL_OAUTH_RETURN: "/profile/gmail/oauth/return",
  KAI_ONBOARDING: "/one/onboarding",
  ONE_ONBOARDING: "/one/onboarding",
  ONE_SETUP: "/one/setup",
  ONE_SETUP_KAI: "/one/setup/kai",
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
  KAI_SETUP: "/one/setup/kai",
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

export function buildOneSetupKaiRoute(entries?: {
  from?: string | null;
  invite?: string | null;
}) {
  return withQuery(ROUTES.ONE_SETUP_KAI, {
    from: normalizeInternalRouteHref(entries?.from),
    invite: entries?.invite,
  });
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

/**
 * Setup-scoped handoff route for a single capability, e.g.
 * `/one/setup/gmail`. These routes live UNDER `/one/setup/*`, which is
 * already allow-listed through `OneSetupGuard` (see
 * {@link isOneSetupWizardRoute}). The setup hub points every "Set up" /
 * "Explore" tile here so a first-time user is never bounced by the hard gate.
 * The handoff page records the capability setup signal, then forwards to the
 * canonical capability route (see {@link CAPABILITY_HANDOFF_TARGETS}).
 */
export function buildOneSetupCapabilityRoute(capabilityId: string): string {
  return `${ROUTES.ONE_SETUP}/${capabilityId}`;
}

/**
 * Canonical post-handoff destination per capability. After the
 * `/one/setup/<id>` handoff records the capability signal, it forwards here.
 * Finance forwards into the guided investor-preferences wizard
 * (`/one/setup/kai`), which then chains persona -> portfolio import
 * (`/one/kai/import`) -> dashboard. Sending finance straight to the dashboard
 * orphaned the questionnaire and import, so the tile now opens the actual
 * setup journey. Consent forwards to the pending tab of the consent center.
 * Anything not listed falls back to the setup hub so a typo'd handoff is
 * contained, never a hard 404.
 */
export const CAPABILITY_HANDOFF_TARGETS: Readonly<Record<string, string>> = {
  finance: ROUTES.ONE_SETUP_KAI,
  gmail: ROUTES.GMAIL,
  email: ROUTES.ONE_KYC,
  location: ROUTES.ONE_LOCATION,
  pkm: ROUTES.PKM,
  consent: `${ROUTES.CONSENTS}?tab=pending`,
  "connected-systems": ROUTES.CONNECTED_SYSTEMS,
};

export function resolveCapabilityHandoffTarget(capabilityId: string): string {
  return CAPABILITY_HANDOFF_TARGETS[capabilityId] ?? ROUTES.ONE_SETUP;
}

/**
 * Build a `/one/setup` hub route. A specific capability can be deep-linked via
 * the `feature` query param (e.g. `/one/setup?feature=gmail`). Query-backed
 * (not a `[feature]` path segment) so the Capacitor static export does not need
 * `generateStaticParams` for every capability id.
 */
export function buildOneSetupRoute(entries?: {
  feature?: string | null;
  from?: string | null;
}) {
  return withQuery(ROUTES.ONE_SETUP, {
    feature: entries?.feature,
    from: normalizeInternalRouteHref(entries?.from),
  });
}

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

/**
 * The `/one/setup` capability hub — the canonical setup entry. A fresh user
 * lands here; the investor-preferences wizard opens from the finance tile and
 * lives at `/one/setup/kai`.
 */
export function isOneSetupRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.ONE_SETUP || pathname.startsWith(`${ROUTES.ONE_SETUP}/`)
  );
}

/**
 * Catalog capability ids that have a dedicated setup step at
 * `/one/setup/<id>`. Kept here (a routing concern) rather than imported
 * from the capability catalog to avoid a circular import — the catalog already
 * imports from this module. Keep in sync with `ONE_CAPABILITIES`.
 * Note: `kai` is intentionally NOT a capability id; the static
 * `/one/setup/kai` wizard segment wins over the `[capability]` dynamic route.
 */
export const ONE_SETUP_CAPABILITY_IDS: readonly string[] = [
  "finance",
  "gmail",
  "email",
  "location",
  "pkm",
  "consent",
  "connected-systems",
];

/**
 * The setup-scoped per-capability step route, e.g. `/one/setup/gmail`.
 * Distinct from the investor-preferences WIZARD: the step records the capability
 * signal and forwards to the canonical capability route. The guard must ALLOW it
 * through (it lives under `/one/setup/*`) but must NOT treat it as the wizard —
 * otherwise a resolved user tapping a setup tile would be bounced to `/one`
 * instead of reaching the capability. Only KNOWN capability ids match, so
 * reserved sub-paths like `/one/setup/kai` are unaffected.
 */
export function isOneSetupCapabilityRoute(pathname: string): boolean {
  const prefix = `${ROUTES.ONE_SETUP}/`;
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) return false;
  return ONE_SETUP_CAPABILITY_IDS.includes(rest);
}

/**
 * The investor-preferences wizard route at `/one/setup/kai`. Distinct from
 * {@link isOneSetupRoute} and {@link isOneSetupCapabilityRoute}: the wizard is
 * the guided preferences sub-step, while the hub is the root setup surface and
 * the capability handoff is a transient redirector.
 */
export function isOneSetupWizardRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.ONE_SETUP_KAI ||
    pathname.startsWith(`${ROUTES.ONE_SETUP_KAI}/`)
  );
}

/**
 * True for any route in the One setup surface: the canonical `/one/setup` hub,
 * the investor-preferences wizard at `/one/setup/kai`, OR a per-capability
 * handoff at `/one/setup/<id>`. Guards and chrome use this so all render setup
 * chrome and are allowed through the setup gate while the root flow is
 * unresolved.
 */
export function isOneSetupSurfaceRoute(pathname: string): boolean {
  return isOneSetupRoute(pathname) || isKaiOnboardingRoute(pathname);
}

export function isKaiOnboardingRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.ONE_ONBOARDING ||
    pathname.startsWith(`${ROUTES.ONE_ONBOARDING}/`) ||
    pathname === ROUTES.LEGACY_KAI_ONBOARDING ||
    pathname.startsWith(`${ROUTES.LEGACY_KAI_ONBOARDING}/`) ||
    pathname === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||
    pathname.startsWith(`${ROUTES.LEGACY_ONE_KAI_ONBOARDING}/`)
  );
}

export function isPublicRoute(pathname: string): boolean {
  return (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.LOGIN ||
    pathname === ROUTES.GETTING_STARTED ||
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
