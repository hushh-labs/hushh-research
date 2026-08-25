/**
 * Central route contract for the web + Capacitor app.
 * Keep every app-level navigation target here to avoid drift.
 */

export { ONE_SETUP_CAPABILITY_IDS } from "@/lib/onboarding/setup-capability-ids";

/** The Finance workspace is a One-owned query-tabbed route, not a nested market page. */
export const KAI_MARKET_PATH = "/one/kai";
/** Browser-only Firebase handoff; never part of signed-in app navigation. */
export const HUSHH_TECH_LAUNCH_PATH = "/products/hushh-tech/launch";

export type KaiMarketTab = "market" | "portfolio" | "analysis";
export type KaiPortfolioSection =
  "holdings" | "allocation" | "performance" | "sources";

function withQuery(
  pathname: string,
  entries: Record<string, string | null | undefined>,
) {
  const [basePath = pathname, existingQuery = ""] = pathname.split("?", 2);
  const params = new URLSearchParams(existingQuery);

  for (const [key, value] of Object.entries(entries)) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      params.set(key, normalized);
    }
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** Build every canonical Finance workspace URL from one path and explicit tab. */
export function buildKaiMarketRoute(
  tab: KaiMarketTab,
  entries: Record<string, string | null | undefined> = {},
) {
  const { tab: _ignoredTab, ...safeEntries } = entries;
  return withQuery(KAI_MARKET_PATH, { tab, ...safeEntries });
}

export function buildKaiPortfolioSectionRoute(
  section: KaiPortfolioSection,
): string {
  return `${KAI_MARKET_PATH}/portfolio/${section}`;
}

export function financeRoutePathname(value: string | null | undefined): string {
  return String(value || "").split("?", 1)[0] || "";
}

export function isKaiMarketPathname(value: string | null | undefined): boolean {
  return financeRoutePathname(value) === KAI_MARKET_PATH;
}

export const ROUTES = {
  HOME: "/",
  /** Canonical public knowledge workspace; root remains anonymous onboarding. */
  WELCOME: "/welcome",
  ONE_HOME: "/one",
  DEVELOPERS: "/developers",
  RESEARCH: "/research",
  RESEARCH_PROTOCOL: "/research/protocol",
  BLOG: "/blog",
  LOGIN: "/login",
  GETTING_STARTED: "/getting-started",
  LOGOUT: "/logout",
  PHONE_MANDATE: "/register-phone",
  PROFILE: "/one/profile",
  PROFILE_REGULATORY: "/one/profile/regulatory",
  PROFILE_ACCOUNT: "/one/profile/account",
  PROFILE_ACCOUNT_PHONE: "/one/profile/account/phone",
  PROFILE_PREFERENCES: "/one/profile/preferences",
  PROFILE_PREFERENCES_KAI: "/one/profile/preferences/kai",
  PROFILE_PREFERENCES_GEMINI: "/one/profile/preferences/gemini",
  PROFILE_PREFERENCES_DEVICE: "/one/profile/preferences/device",
  PROFILE_PREFERENCES_VOICE: "/one/profile/preferences/voice",
  PROFILE_PREFERENCES_VOICE_CHANGELOG:
    "/one/profile/preferences/voice/changelog",
  PROFILE_PREFERENCES_VOICE_EXAMPLES:
    "/one/profile/preferences/voice/examples",
  PROFILE_SECURITY: "/one/profile/security",
  PROFILE_SECURITY_VAULT: "/one/profile/security/vault",
  PROFILE_SECURITY_SESSION: "/one/profile/security/session",
  PROFILE_SECURITY_DEVICES: "/one/profile/security/devices",
  PROFILE_SECURITY_DEVICE_AUTHORIZE: "/one/profile/security/devices/authorize",
  PROFILE_MY_DATA: "/one/profile/my-data",
  PROFILE_MY_DATA_DOMAIN: "/one/profile/my-data/domain",
  PROFILE_ACCESS: "/one/profile/access",
  PROFILE_ACCESS_CONNECTION: "/one/profile/access/connection",
  PROFILE_CONNECTED_SYSTEMS: "/one/profile/connected-systems",
  PROFILE_GMAIL: "/one/profile/gmail",
  PROFILE_GMAIL_CONNECTION: "/one/profile/gmail/connection",
  PROFILE_GMAIL_ACTIONS: "/one/profile/gmail/actions",
  PROFILE_REFERRALS: "/one/profile/referrals",
  PROFILE_SUPPORT: "/one/profile/support",
  PROFILE_SUPPORT_ROUTING: "/one/profile/support/routing",
  PROFILE_SUPPORT_COMPOSE: "/one/profile/support/compose",
  PROFILE_PKM: "/one/profile/pkm",
  PROFILE_PKM_AGENT_LAB: "/one/profile/pkm-agent-lab",
  PROFILE_RECEIPTS: "/one/profile/receipts",
  PROFILE_GMAIL_OAUTH_RETURN: "/one/profile/gmail/oauth/return",
  /** Compatibility redirect only; Calendar now has its own agent workspace. */
  PROFILE_INTEGRATIONS: "/one/profile/integrations",
  PROFILE_GOOGLE_OAUTH_RETURN: "/one/profile/google/oauth/return",
  OAUTH_AUTHORIZE: "/oauth/authorize",
  ONE_SETUP: "/one/setup",
  ONE_SETUP_FINANCE: "/one/setup/finance",
  ONE_SETUP_FINANCE_IMPORT: "/one/setup/finance/import",
  ONE_SETUP_KAI: "/one/setup/kai",
  ONE_SETUP_GMAIL: "/one/setup/gmail",
  ONE_SETUP_CALENDAR: "/one/setup/calendar",
  ONE_SETUP_LOCATION: "/one/setup/location",
  ONE_SETUP_EMAIL: "/one/setup/email",
  ONE_SETUP_RIA: "/one/setup/ria",
  ONE_SETUP_CONNECTED_SYSTEMS: "/one/setup/connected-systems",
  ONE_SETUP_CONNECTIONS: "/one/setup/connections",
  GMAIL: "/one/gmail",
  CALENDAR: "/one/calendar",
  PKM: "/one/pkm",
  ONE_MARKETPLACE: "/one/marketplace",
  /** Owner setup and management for the Apple Wallet profile pass. */
  ONE_WALLET_CARD: "/one/wallet-card",
  CONNECTED_SYSTEMS: "/one/connected-systems",
  /** Canonical One workspace for consent review and access management. */
  CONSENTS: "/one/consent",
  /** Cross-domain activity feed: consent, location, Kai, KYC, connected systems, connections. */
  ONE_FEED: "/one/feed",
  /** Compatibility-only access manager route. Preserve inbound partner links. */
  LEGACY_CONSENTS: "/consents",
  AGENT: "/agent",
  CONNECT: "/one/connect",
  CONNECT_SETTINGS: "/one/connect/settings",
  MARKETPLACE: "/marketplace",
  MARKETPLACE_CONNECTIONS: "/marketplace/connections",
  MARKETPLACE_RIA_PROFILE: "/marketplace/ria",
  ONE_KYC: "/one/kyc",
  ONE_LOCATION: "/one/location",
  /** Immersive, consented multi-person Location map. */
  ONE_LOCATION_MAP: "/one/location/map",
  /**
   * Nearby check-in. Its own destination, not a drawer over the map: the map
   * shows people who already share with you, while check-in makes you briefly
   * discoverable to opted-in people at a place. They were one screen and read
   * as the same feature.
   */
  ONE_LOCATION_CHECK_IN: "/one/location/check-in",
  /**
   * Recipient landing for a shared Circle join link. An entry point from
   * outside the app, like LOGIN — the destination is the reason the person
   * opened the app at all, so it must render before setup is checked.
   */
  CIRCLE_JOIN: "/circle/join",
  LEGACY_GMAIL: "/gmail",
  LEGACY_PKM: "/pkm",
  LEGACY_CONNECTED_SYSTEMS: "/connected-systems",
  /** Compatibility-only Finance root. Canonical navigation stays under One. */
  LEGACY_KAI_HOME: "/kai",
  LEGACY_ONE_KAI_MARKET: "/one/kai/market",
  LEGACY_KAI_ONBOARDING: "/kai/onboarding",
  LEGACY_ONE_KAI_ONBOARDING: "/one/kai/onboarding",
  LEGACY_KAI_IMPORT: "/kai/import",
  LEGACY_KAI_PLAID_OAUTH_RETURN: "/kai/plaid/oauth/return",
  LEGACY_KAI_ALPACA_OAUTH_RETURN: "/kai/alpaca/oauth/return",
  LEGACY_KAI_PORTFOLIO: "/kai/portfolio",
  LEGACY_KAI_ANALYSIS: "/kai/analysis",
  /** One-release redirect only. Optimize is no longer a product surface. */
  LEGACY_KAI_OPTIMIZE_COMPAT: "/kai/optimize",
  /** Compatibility redirect only; new RIA entry points use the profile tab. */
  RIA_HOME: "/ria",
  RIA_ONBOARDING: "/ria/onboarding",
  RIA_CLAIM: "/ria/claim",
  RIA_CLIENTS: "/ria/clients",
  RIA_WORKSPACE: "/ria/workspace",
  RIA_REQUESTS: "/ria/requests",
  RIA_PICKS: "/ria/picks",
  RIA_SETTINGS: "/ria/settings",
  RIA_PROFILE: "/ria/profile",
  KAI_HOME: buildKaiMarketRoute("market"),
  /** Finite Market workspace. This is not a fourth Finance tab. */
  KAI_NEWS: "/one/kai/news",
  KAI_SETUP: "/one/setup/finance",
  KAI_IMPORT: "/one/kai/import",
  KAI_PLAID_OAUTH_RETURN: "/one/kai/plaid/oauth/return",
  KAI_ALPACA_OAUTH_RETURN: "/one/kai/alpaca/oauth/return",
  KAI_PORTFOLIO: buildKaiMarketRoute("portfolio"),
  KAI_PORTFOLIO_HOLDINGS: "/one/kai/portfolio/holdings",
  KAI_PORTFOLIO_ALLOCATION: "/one/kai/portfolio/allocation",
  KAI_PORTFOLIO_PERFORMANCE: "/one/kai/portfolio/performance",
  KAI_PORTFOLIO_SOURCES: "/one/kai/portfolio/sources",
  KAI_DASHBOARD: buildKaiMarketRoute("portfolio"),
  KAI_ANALYSIS: buildKaiMarketRoute("analysis"),
  /** One-release redirect only. Optimize is no longer a product surface. */
  KAI_OPTIMIZE_COMPAT: "/one/kai/optimize",
} as const;

export function buildMarketplaceRiaProfileRoute(riaId?: string | null) {
  return withQuery(ROUTES.MARKETPLACE_RIA_PROFILE, { riaId });
}

export function buildPhoneMandateRoute(redirect?: string | null) {
  return withQuery(ROUTES.PHONE_MANDATE, { redirect });
}

/**
 * Returns to the public One introduction without relying on browser history.
 *
 * Login is a child of the anonymous onboarding journey, not of whichever
 * route happened to send a person to sign-in. Preserve a verified intended
 * destination so claiming One again continues the same journey, while a
 * missing or unsafe value resolves to the canonical root route.
 */
export function buildWelcomeRoute(redirect?: string | null) {
  return withQuery(ROUTES.HOME, {
    redirect: normalizeInternalRouteHref(redirect),
  });
}

export function normalizeInternalRouteHref(
  value: string | null | undefined,
): string | null {
  const href = String(value ?? "").trim();
  if (!href) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(href) || /%5c/i.test(href)) return null;
  try {
    const parsed = new URL(href, "https://one.local");
    if (parsed.origin !== "https://one.local") return null;
    const canonical = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return canonical === href ? canonical : null;
  } catch {
    return null;
  }
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
  return withQuery(ROUTES.ONE_SETUP_FINANCE, {
    from: normalizeInternalRouteHref(entries?.from),
    invite: entries?.invite,
  });
}

/**
 * Setup-scoped workspace route for a single capability. Every first-run
 * capability lives here; normal product workspaces remain outside setup.
 */
export function buildOneSetupCapabilityRoute(capabilityId: string): string {
  return SETUP_CAPABILITY_ROUTES[capabilityId] ?? ROUTES.ONE_SETUP;
}

/**
 * Deprecated compatibility helper. Completion is never encoded in a URL.
 * Callers must use the setup coordinator's verified finish transition.
 */
export function buildOneSetupCapabilityFinishRoute(
  capabilityId: string,
): string {
  return buildOneSetupCapabilityRoute(capabilityId);
}

/** Static setup workspaces. This is intentionally exact rather than a prefix. */
export const SETUP_CAPABILITY_ROUTES: Readonly<Record<string, string>> = {
  gmail: ROUTES.ONE_SETUP_GMAIL,
  calendar: ROUTES.ONE_SETUP_CALENDAR,
  location: ROUTES.ONE_SETUP_LOCATION,
  email: ROUTES.ONE_SETUP_EMAIL,
  finance: ROUTES.ONE_SETUP_FINANCE,
  ria: ROUTES.ONE_SETUP_RIA,
  "connected-systems": ROUTES.ONE_SETUP_CONNECTED_SYSTEMS,
};

/**
 * Setup-owned routes that configure the root private agent but are not agent
 * capabilities. Keep these out of `SETUP_CAPABILITY_ROUTES`: they must be
 * admitted by the root journey without inventing capability completion or a
 * generated voice action.
 */
export const SETUP_NAVIGATION_ROUTES: readonly string[] = [
  ROUTES.ONE_SETUP_CONNECTIONS,
];

/** Normal (post-setup) destinations; never use these to admit unresolved setup. */
export const CAPABILITY_HANDOFF_TARGETS: Readonly<Record<string, string>> = {
  finance: ROUTES.KAI_HOME,
  gmail: ROUTES.GMAIL,
  calendar: ROUTES.CALENDAR,
  email: ROUTES.ONE_KYC,
  location: ROUTES.ONE_LOCATION,
  ria: ROUTES.RIA_ONBOARDING,
  "connected-systems": ROUTES.CONNECTED_SYSTEMS,
};

export function resolveCapabilityHandoffTarget(capabilityId: string): string {
  return CAPABILITY_HANDOFF_TARGETS[capabilityId] ?? ROUTES.ONE_SETUP;
}

export type CompletedSetupCapabilityEntry =
  | { kind: "continue" }
  | { kind: "acknowledge"; target: string }
  | { kind: "redirect"; target: string };

/**
 * Resolve a durable completion before a capability setup body mounts.
 *
 * Location is the only capability with a first-run flow that can finish while
 * the root setup hub remains active. Re-entering that completed row briefly
 * acknowledges the saved result and returns to the hub; it must never replay
 * permissions, contacts, or the circle confirmation. Once root setup itself
 * is resolved, the canonical Location workspace remains the handoff target.
 */
export function resolveCompletedSetupCapabilityEntry({
  capabilityId,
  completedCapabilityIds,
  rootSetupResolved,
}: {
  capabilityId: string;
  completedCapabilityIds: readonly string[];
  rootSetupResolved: boolean;
}): CompletedSetupCapabilityEntry {
  if (
    capabilityId !== "location" ||
    !completedCapabilityIds.includes(capabilityId)
  ) {
    return { kind: "continue" };
  }

  return rootSetupResolved
    ? { kind: "redirect", target: ROUTES.ONE_LOCATION }
    : { kind: "acknowledge", target: ROUTES.ONE_SETUP };
}

/**
 * No normal product route is an unresolved-setup handoff target. This export
 * is retained for callers that need to distinguish the historical model.
 */
const GATED_CAPABILITY_HANDOFF_TARGETS: ReadonlySet<string> = new Set();

/**
 * True when `pathname` is a hard-gated capability handoff target (see
 * {@link GATED_CAPABILITY_HANDOFF_TARGETS}). `OneOnboardingGuard` uses this,
 * to identify canonical workspace destinations. Admission comes from the
 * durable active-capability record, never from a query marker.
 */
export function isCapabilityHandoffTarget(pathname: string): boolean {
  return GATED_CAPABILITY_HANDOFF_TARGETS.has(pathname);
}

/**
 * Route families an unresolved setup journey may enter for its ONE durable
 * active capability. This replaces the fragile `?from=/one/setup` admission
 * marker: query parameters describe navigation history, while the verified
 * pre-vault journey record supplies authority.
 *
 * Keep this deliberately narrow. A capability can navigate within its setup
 * workspace and callback routes, but it cannot use onboarding as a blanket
 * grant for unrelated signed-in surfaces.
 */
export const CAPABILITY_ONBOARDING_ROUTE_PREFIXES: Readonly<
  Record<string, readonly string[]>
> = {
  finance: [
    ROUTES.ONE_SETUP_FINANCE,
    ROUTES.ONE_SETUP_FINANCE_IMPORT,
    ROUTES.KAI_PLAID_OAUTH_RETURN,
  ],
  gmail: [ROUTES.ONE_SETUP_GMAIL, ROUTES.PROFILE_GMAIL_OAUTH_RETURN],
  calendar: [ROUTES.ONE_SETUP_CALENDAR, ROUTES.PROFILE_GOOGLE_OAUTH_RETURN],
  email: [ROUTES.ONE_SETUP_EMAIL],
  location: [ROUTES.ONE_SETUP_LOCATION],
  // RIA_CLAIM belongs to the ria capability: recognising an adviser from their
  // filed number routes here from setup, and the journey guard must admit it
  // or the redirect is bounced straight back to the hub.
  // RIA_PROFILE too: the claim done screen offers "View profile", and the RIA
  // onboarding page redirects established advisers there. Without admission the
  // guard bounces that redirect to the onboarding page, which redirects back to
  // the profile — an infinite loop while setup is unresolved.
  ria: [ROUTES.ONE_SETUP_RIA, ROUTES.RIA_CLAIM, ROUTES.RIA_PROFILE],
  "connected-systems": [ROUTES.ONE_SETUP_CONNECTED_SYSTEMS],
};

/** True only when the route belongs to the verified active capability. */
export function isCapabilityOnboardingRoute(
  capabilityId: string | null | undefined,
  pathname: string,
): boolean {
  if (!capabilityId) return false;
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (CAPABILITY_ONBOARDING_ROUTE_PREFIXES[capabilityId] || []).some(
    (route) => normalizedPathname === route,
  );
}

/** Resolve the authored capability whose onboarding route family owns a path. */
export function resolveOnboardingCapabilityForRoute(
  pathname: string,
): string | null {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  for (const [capabilityId, prefixes] of Object.entries(
    CAPABILITY_ONBOARDING_ROUTE_PREFIXES,
  )) {
    if (prefixes.some((route) => normalizedPathname === route)) {
      return capabilityId;
    }
  }
  return null;
}

/** True when completed Location setup owns the requested workspace route. */
export function isCompletedLocationWorkspaceRoute(
  completedCapabilityIds: readonly string[] | null | undefined,
  pathname: string,
): boolean {
  if (!completedCapabilityIds?.includes("location")) {
    return false;
  }
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.ONE_LOCATION ||
    normalizedPathname.startsWith(`${ROUTES.ONE_LOCATION}/`)
  );
}

/**
 * Anonymous/editorial, prerequisite, and account-recovery routes that never
 * participate in the authenticated root-setup admission decision. Profile is
 * deliberately exempt so a failed setup/bootstrap dependency can never trap a
 * signed-in user away from sign-out or account deletion.
 */
export function isOnboardingAdmissionExemptRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.WELCOME ||
    normalizedPathname === ROUTES.DEVELOPERS ||
    normalizedPathname === ROUTES.RESEARCH ||
    normalizedPathname.startsWith(`${ROUTES.RESEARCH}/`) ||
    normalizedPathname === ROUTES.BLOG ||
    normalizedPathname.startsWith(`${ROUTES.BLOG}/`) ||
    normalizedPathname === ROUTES.LOGIN ||
    normalizedPathname.endsWith("-visual-preview") ||
    isFirebaseSessionOnlyRoute(normalizedPathname) ||
    normalizedPathname === ROUTES.GETTING_STARTED ||
    normalizedPathname === ROUTES.PHONE_MANDATE ||
    // Reached straight from the phone mandate when the number the adviser just
    // verified is on an SEC filing, before any capability is active.
    normalizedPathname === ROUTES.RIA_CLAIM ||
    normalizedPathname === ROUTES.LOGOUT ||
    normalizedPathname === ROUTES.PROFILE ||
    normalizedPathname.startsWith(`${ROUTES.PROFILE}/`) ||
    normalizedPathname.startsWith(`${ROUTES.ONE_LOCATION}/view/`) ||
    normalizedPathname.startsWith(`${ROUTES.ONE_LOCATION}/request/`) ||
    normalizedPathname === ROUTES.CIRCLE_JOIN
  );
}

/** Routes that require Firebase identity, but no setup or private-place state. */
export function isFirebaseSessionOnlyRoute(pathname: string): boolean {
  const pathOnly = String(pathname || "/").split(/[?#]/, 1)[0] || "/";
  return normalizeStaticExportPathname(pathOnly) === HUSHH_TECH_LAUNCH_PATH;
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
  returnTo?: string | null;
}) {
  return withQuery(ROUTES.ONE_SETUP, {
    feature: entries?.feature,
    from: normalizeInternalRouteHref(entries?.from),
    return_to: normalizeInternalRouteHref(entries?.returnTo),
  });
}

export function buildProfileVaultRoute(returnTo?: string | null) {
  return withQuery(ROUTES.PROFILE_SECURITY, {
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

export function buildConnectedSystemRoute(
  systemId?: string | null,
  entries?: { agentActionId?: string | null },
) {
  const normalized = String(systemId ?? "").trim();
  if (!normalized) return ROUTES.CONNECTED_SYSTEMS;
  return withQuery(
    `${ROUTES.CONNECTED_SYSTEMS}/${encodeURIComponent(normalized)}`,
    {
      agentActionId: entries?.agentActionId,
    },
  );
}

export function buildMarketplaceConnectionPortfolioRoute(
  connectionId?: string | null,
) {
  const normalized = String(connectionId ?? "").trim();
  if (!normalized) return ROUTES.RIA_CLIENTS;
  return buildRiaClientWorkspaceRoute(normalized, { tab: "kai" });
}

export function buildRiaClientWorkspaceRoute(
  clientId?: string | null,
  entries?: {
    tab?: "overview" | "access" | "kai" | "explorer" | null;
    testProfile?: boolean | null;
  },
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
  },
) {
  const normalizedClientId = String(clientId ?? "").trim();
  const normalizedAccountId = String(accountId ?? "").trim();
  if (!normalizedClientId || !normalizedAccountId) return ROUTES.RIA_CLIENTS;
  return withQuery(
    `${ROUTES.RIA_CLIENTS}/${encodeURIComponent(normalizedClientId)}/accounts/${encodeURIComponent(
      normalizedAccountId,
    )}`,
    {
      test_profile: entries?.testProfile ? "1" : null,
    },
  );
}

export function buildRiaClientRequestRoute(
  clientId?: string | null,
  requestId?: string | null,
  entries?: {
    testProfile?: boolean | null;
  },
) {
  const normalizedClientId = String(clientId ?? "").trim();
  const normalizedRequestId = String(requestId ?? "").trim();
  if (!normalizedClientId || !normalizedRequestId) return ROUTES.RIA_CLIENTS;
  return withQuery(
    `${ROUTES.RIA_CLIENTS}/${encodeURIComponent(normalizedClientId)}/requests/${encodeURIComponent(
      normalizedRequestId,
    )}`,
    {
      test_profile: entries?.testProfile ? "1" : null,
    },
  );
}

export function buildRiaWorkspaceRoute(
  clientId?: string | null,
  entries?: {
    tab?: "overview" | "access" | "kai" | "explorer" | null;
    testProfile?: boolean | null;
  },
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
 * lives at `/one/setup/finance`.
 */
export function isOneSetupRoute(pathname: string): boolean {
  return normalizeStaticExportPathname(pathname) === ROUTES.ONE_SETUP;
}

/**
 * Capacitor uses Next's static export, which represents directory routes with
 * a trailing slash (and may expose the backing index document while settling
 * a WebView navigation). Route admission must compare the logical app route,
 * not that transport-specific pathname shape.
 */
export function normalizeStaticExportPathname(pathname: string): string {
  const withoutIndexDocument = String(pathname || "/").replace(
    /\/index\.html$/i,
    "",
  );
  const withoutTrailingSlash = withoutIndexDocument.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

/**
 * The setup-scoped per-capability step route, e.g. `/one/setup/gmail`.
 * Distinct from the investor-preferences WIZARD: the step records the capability
 * signal and forwards to the canonical capability route. The guard must ALLOW it
 * through (it lives under `/one/setup/*`) but must NOT treat it as the wizard —
 * otherwise a resolved user tapping a setup tile would be bounced to `/one`
 * instead of reaching the capability. Only KNOWN capability ids match, so
 * reserved wizard and compatibility sub-paths are unaffected.
 */
export function isOneSetupCapabilityRoute(pathname: string): boolean {
  return Object.values(SETUP_CAPABILITY_ROUTES).includes(
    normalizeStaticExportPathname(pathname),
  );
}

export function isOneSetupNavigationRoute(pathname: string): boolean {
  return SETUP_NAVIGATION_ROUTES.includes(
    normalizeStaticExportPathname(pathname),
  );
}

/**
 * The investor-preferences wizard routes at `/one/setup/finance` and its
 * source-selection child. The legacy `/one/setup/kai` route is compatibility-only.
 * This is distinct from
 * {@link isOneSetupRoute} and {@link isOneSetupCapabilityRoute}: the wizard is
 * the guided preferences sub-step, while the hub is the root setup surface and
 * the capability handoff is a transient redirector.
 */
export function isOneSetupWizardRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.ONE_SETUP_FINANCE ||
    normalizedPathname === ROUTES.ONE_SETUP_FINANCE_IMPORT ||
    normalizedPathname === ROUTES.ONE_SETUP_KAI
  );
}

/**
 * True for any route in the One setup surface: the canonical `/one/setup` hub,
 * the investor-preferences wizard at `/one/setup/finance`, OR a per-capability
 * handoff at `/one/setup/<id>`. Guards and chrome use this so all render setup
 * chrome and are allowed through the setup gate while the root flow is
 * unresolved.
 */
export function isOneSetupSurfaceRoute(pathname: string): boolean {
  return (
    isOneSetupRoute(pathname) ||
    isOneSetupNavigationRoute(pathname) ||
    isOneSetupCapabilityRoute(pathname) ||
    isOneSetupWizardRoute(pathname)
  );
}

/**
 * Public Wallet Profile prefix. Deliberately a module-local constant rather
 * than a ROUTES entry: `/c` is a token namespace with no page of its own, so it
 * needs neither a native-route-inventory classification nor a ROUTES-derived
 * app-route-layout entry. Precedent: the location public-invite prefix is
 * likewise not a ROUTES value.
 */
const WALLET_CARD_PUBLIC_PREFIX = "/c";

export function isPublicRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.WELCOME ||
    normalizedPathname === ROUTES.DEVELOPERS ||
    normalizedPathname === ROUTES.LOGIN ||
    normalizedPathname === ROUTES.GETTING_STARTED ||
    normalizedPathname === ROUTES.PHONE_MANDATE ||
    normalizedPathname === ROUTES.LOGOUT ||
    normalizedPathname === ROUTES.RESEARCH ||
    normalizedPathname.startsWith(`${ROUTES.RESEARCH}/`) ||
    normalizedPathname === ROUTES.BLOG ||
    normalizedPathname.startsWith(`${ROUTES.BLOG}/`) ||
    // Both prefixes. `/view/` is where public live-location links point now;
    // `/request/` is what every link minted before the rename carries, and it
    // has to stay public or those land on /login instead of on the forwarder
    // that would have taken them to the right page.
    normalizedPathname.startsWith(`${ROUTES.ONE_LOCATION}/view/`) ||
    normalizedPathname.startsWith(`${ROUTES.ONE_LOCATION}/request/`) ||
    normalizedPathname === WALLET_CARD_PUBLIC_PREFIX ||
    normalizedPathname.startsWith(`${WALLET_CARD_PUBLIC_PREFIX}/`)
  );
}

/**
 * Routes that must emit no analytics at all (Wallet Profile contract §7).
 *
 * A visitor scanning someone's Wallet Profile QR never agreed to anything with
 * us — they are not a user, they arrived from a stranger's printed code, and we
 * do not get to measure them. Deliberately much narrower than `isPublicRoute`:
 * the marketing and auth routes there are ours to instrument.
 */
export function isAnalyticsExemptRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === WALLET_CARD_PUBLIC_PREFIX ||
    normalizedPathname.startsWith(`${WALLET_CARD_PUBLIC_PREFIX}/`)
  );
}

/**
 * Public editorial routes that share One's Foundation ambient presentation and
 * voice-only controls. Keep this narrower than isPublicRoute: auth, profile,
 * phone, and public invite routes have their own security/UI contracts.
 */
export function isFoundationPublicRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.WELCOME ||
    normalizedPathname === ROUTES.DEVELOPERS ||
    normalizedPathname === ROUTES.RESEARCH ||
    normalizedPathname.startsWith(`${ROUTES.RESEARCH}/`) ||
    normalizedPathname === ROUTES.BLOG ||
    normalizedPathname.startsWith(`${ROUTES.BLOG}/`)
  );
}

export function isRiaRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.RIA_HOME ||
    normalizedPathname.startsWith(`${ROUTES.RIA_HOME}/`)
  );
}

export function isRiaOnboardingRoute(pathname: string): boolean {
  const normalizedPathname = normalizeStaticExportPathname(pathname);
  return (
    normalizedPathname === ROUTES.RIA_ONBOARDING ||
    normalizedPathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`)
  );
}

export function isRiaActionBarRoute(
  pathname: string | null | undefined,
): boolean {
  const path = pathname ?? "";
  return isRiaRoute(path) && !isRiaOnboardingRoute(path);
}
