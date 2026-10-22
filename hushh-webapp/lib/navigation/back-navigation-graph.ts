// lib/navigation/back-navigation-graph.ts
//
// The declarative back-navigation graph. This is the single source of truth
// `resolveTopShellBreadcrumbInner` (top-shell-breadcrumbs.ts) walks to decide
// where Back goes for any pathname+searchParams. Each entry is a named node;
// `resolve` returns `undefined` when the node doesn't own this pathname (the
// walker tries the next node, preserving the exact fall-through semantics the
// previous if-chain relied on — e.g. an RIA client route with an unrecognized
// section, or a Connect circles flow with no focused action, both fall through
// to a later, more general node), `null` when the node owns the pathname but
// explicitly has no breadcrumb, or a `TopShellBreadcrumbConfig` otherwise.
//
// Order matters: nodes are walked first-match-wins, in the same order the
// original if-chain checked them, because several pairs are deliberately
// ordered specific-before-general (e.g. exact `/ria/picks` before the RIA
// subroutes loop; `/one/setup/kai` before the generic `/one/setup/*` node).
//
// scripts/architecture/generate-back-navigation-graph.mjs renders this array
// as a diagram; keep `id` stable and human-readable.

import {
  buildOneSetupCapabilityRoute,
  KAI_MARKET_PATH,
  normalizeInternalRouteHref,
  resolveOnboardingCapabilityForRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { getOneSetupCapability } from "@/lib/onboarding/one-capabilities";
import { resolvePublicKnowledgeTopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import {
  buildProfileRoute,
  connectorDetailTitle,
  resolveProfileRouteState,
  type ProfilePanel,
} from "@/lib/navigation/profile-routes";
import {
  CONNECT_CIRCLES_LIST_HREF,
  connectCircleTaskTitle,
  readConnectCircleAction,
} from "@/lib/navigation/connect-routes";
import {
  buildNearbyCheckInResumeHref,
  isNearbyPrivateReturnToken,
  NEARBY_PRIVATE_RETURN_TOKEN_PARAM,
} from "@/lib/one-location/nearby-private-navigation";
import type { TopShellBreadcrumbConfig } from "@/lib/navigation/top-shell-breadcrumbs";

type SearchParamsLike =
  | URLSearchParams
  | { get(name: string): string | null }
  | null
  | undefined;

export type BackRuleContext = {
  connectedSystemLabel?: string | null;
};

export type BackRule = {
  id: string;
  resolve: (
    pathname: string,
    searchParams: SearchParamsLike,
    ctx: BackRuleContext,
  ) => TopShellBreadcrumbConfig | null | undefined;
};

function titleizeSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Human label for an open Location quick-action flow (the `?action=…` slug).
 * Used as the third breadcrumb crumb while the flow is open so the top-bar
 * reads "One › Location › Check-In" etc. Falls back to a titleized slug.
 */
export function oneLocationActionLabel(action: string): string {
  const labels: Record<string, string> = {
    share: "Share location",
    ask: "Ask for location",
    invite: "Invite to Circle",
    "temp-link": "Public link",
    "check-in": "Check-In",
    "places-visited": "Places you've been",
    "private-check-in": "Private Check-In",
    "active-shares": "Active shares",
    "shared-with-me": "Shared with me",
    "needs-review": "Needs review",
    sos: "Save My Soul",
    "sms-contacts": "Emergency contacts",
    settings: "Settings",
    privacy: "Settings",
    "create-circle": "New circle",
    "join-circle": "Join circle",
    "circle-detail": "Circle",
    "invite-circle": "Invite to circle",
    ratings: "Ratings",
  };
  return labels[action] ?? titleizeSegment(action);
}

/**
 * Which Location flow the SMS-contacts screen returns to.
 *
 * It is reachable from Settings AND from the middle of an SOS, so a fixed
 * target is wrong: sending someone from SOS back to Settings drops them out of
 * the emergency flow at the worst possible moment. The hub records the origin
 * as `?source=sos` when it opens the screen; anything else (including an
 * absent or unrecognised source) means Settings, where the other entry points
 * live. This is the single implementation — `resolveSmsContactsBackFlow` in
 * the Location hub delegates here so the two cannot drift.
 */
export function resolveSmsContactsBackAction(
  source: string | null | undefined,
): "sos" | "settings" {
  return source === "sos" ? "sos" : "settings";
}

function profilePanelLabel(panel: ProfilePanel | null): string | null {
  if (panel === "account") return "Account";
  if (panel === "my-data") return "Memory";
  if (panel === "payouts") return "Payouts";
  if (panel === "request-pricing") return "Request pricing";
  if (panel === "connected-systems") return "Connected Systems";
  if (panel === "connectors") return "Connectors";
  if (panel === "preferences") return "Preferences";
  if (panel === "security") return "Security";
  if (panel === "referrals") return "Invite friends";
  if (panel === "support") return "Support & feedback";
  if (panel === "gmail") return "Mail";
  if (panel === "legal") return "Legal";
  if (panel === "world-model") return "Personal World Model";
  return null;
}

function profilePanelHref(panel: ProfilePanel): string {
  return buildProfileRoute({ panel });
}

/**
 * The Profile hub is opened from wherever the user tapped the avatar (every
 * signed-in screen shows it) and from the agent workspace. Like the other One
 * capability surfaces it therefore honors a validated `?from` origin so the
 * single top-bar back control returns to the screen the user came from instead
 * of always dropping them on the One dashboard. Falls back to One home when no
 * (or an unsafe) origin is present.
 */
function resolveProfileOriginBackHref(searchParams?: SearchParamsLike): string {
  return (
    normalizeInternalRouteHref(searchParams?.get("from")) ?? ROUTES.ONE_HOME
  );
}

/**
 * A clean, from-only params object so nested profile links keep the origin
 * without dragging transient vault/return markers into computed back hrefs.
 */
function profileOriginSearchParams(
  searchParams?: SearchParamsLike,
): URLSearchParams | undefined {
  const from = normalizeInternalRouteHref(searchParams?.get("from"));
  return from ? new URLSearchParams({ from }) : undefined;
}

/** Human label for the origin the Profile hub was opened from. */
export function profileOriginCrumbLabel(backHref: string): string {
  const path = normalizeBreadcrumbPathname(backHref);
  const labels: Record<string, string> = {
    [ROUTES.ONE_HOME]: "One",
    [ROUTES.ONE_LOCATION]: "Location",
    [ROUTES.GMAIL]: "Mail",
    [ROUTES.PKM]: "Memory",
    [ROUTES.PKM_RECENT]: "Recently learned",
    [ROUTES.PKM_LOCATION]: "Location",
    [ROUTES.PKM_LOCATION_DETAIL]: "Detail",
    [ROUTES.ONE_MARKETPLACE]: "Marketplace",
    [ROUTES.CONNECTED_SYSTEMS]: "Connected Systems",
    [ROUTES.CONSENTS]: "Consent Center",
    [ROUTES.ONE_FEED]: "Feed",
    [ROUTES.ONE_MESSAGES]: "Messages",
    [ROUTES.ONE_TODOS]: "To-do List",
    [ROUTES.ONE_KYC]: "KYC",
    [KAI_MARKET_PATH]: "Finance",
    [ROUTES.CONNECT]: "Connect",
  };
  return labels[path] ?? "One";
}

function profileDetailLabel(detail: string | null): string | null {
  if (!detail) return null;
  if (detail.startsWith("domain:")) return "Domain detail";
  if (detail.startsWith("connection:")) return "Connection detail";
  if (detail.startsWith("connector:")) return connectorDetailTitle(detail);
  if (detail === "sharing") return "Sharing";
  if (detail === "appearance") return "Appearance";
  if (detail === "kai-preferences") return "Finance preferences";
  if (detail === "gemini") return "Gemini";
  if (detail === "vault") return "Vault methods";
  if (detail === "session") return "Session";
  if (detail === "danger") return "Danger zone";
  if (detail === "gmail-connection") return "Connection";
  if (detail === "gmail-actions") return "Actions";
  if (detail === "support-routing") return "Help & feedback";
  if (detail.startsWith("support-compose:")) return "Help & feedback";
  return null;
}

export function normalizeBreadcrumbPathname(pathname: string): string {
  const base =
    String(pathname || "")
      .split(/[?#]/, 1)[0]
      ?.trim() || "/";
  if (base === "/") return base;
  const withSlash = base.startsWith("/") ? base : `/${base}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function resolveCapabilitySetupBackHref(
  pathname: string,
  originHref: string | null,
): string | null {
  if (originHref !== ROUTES.ONE_SETUP) return originHref;
  const capabilityId = resolveOnboardingCapabilityForRoute(pathname);
  return capabilityId
    ? buildOneSetupCapabilityRoute(capabilityId)
    : ROUTES.ONE_SETUP;
}

export const BACK_NAVIGATION_RULES: BackRule[] = [
  {
    id: "one-referrals",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_REFERRALS) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "content",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }],
        suppressFallbackTitle: true,
      };
    },
  },
  {
    id: "legal-terms-privacy",
    resolve: (pathname) => {
      if (pathname !== ROUTES.TERMS && pathname !== ROUTES.PRIVACY) return undefined;
      return {
        backHref: ROUTES.LOGIN,
        width: "profile",
        align: "center",
        items: [
          { label: "Legal" },
          { label: pathname === ROUTES.TERMS ? "Terms of Use" : "Privacy Policy" },
        ],
      };
    },
  },
  {
    id: "connect-settings",
    resolve: (pathname) => {
      if (pathname !== ROUTES.CONNECT_SETTINGS) return undefined;
      return {
        backHref: ROUTES.CONNECT,
        width: "content",
        align: "center",
        items: [{ label: "Connect", href: ROUTES.CONNECT }, { label: "Gemini" }],
      };
    },
  },
  {
    id: "one-setup-connections",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_SETUP_CONNECTIONS) return undefined;
      return {
        backHref: ROUTES.ONE_SETUP,
        width: "content",
        align: "center",
        hideBack: false,
        items: [
          { label: "Set up", href: ROUTES.ONE_SETUP },
          { label: "Choose your AI" },
        ],
      };
    },
  },
  {
    id: "one-initial-welcome",
    resolve: (pathname) => pathname === ROUTES.ONE_WELCOME
      ? { backHref: ROUTES.HOME, hideBack: true, items: [] } : undefined,
  },
  {
    id: "one-wallet",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_WALLET) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "content",
        align: "center",
        suppressFallbackTitle: true,
        items: [{ label: "One", href: ROUTES.ONE_HOME }],
      };
    },
  },
  {
    id: "welcome",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.WELCOME) return undefined;
      const tabSet = resolvePublicKnowledgeTopShellTabSet(
        `${pathname}?tab=${searchParams?.get("tab") ?? ""}`,
      );
      if (!tabSet) return null;
      return {
        backHref: ROUTES.HOME,
        width: "content",
        align: "center",
        hideBack: false,
        items: [],
      };
    },
  },
  {
    id: "public-pages",
    resolve: (pathname) => {
      if (
        pathname !== ROUTES.DEVELOPERS &&
        pathname !== ROUTES.RESEARCH &&
        pathname !== ROUTES.BLOG &&
        pathname !== ROUTES.RESEARCH_PROTOCOL
      )
        return undefined;
      return { backHref: ROUTES.HOME, width: "content", align: "center", items: [] };
    },
  },
  {
    id: "blog-post",
    resolve: (pathname) => {
      if (!pathname.startsWith(`${ROUTES.BLOG}/`)) return undefined;
      return {
        backHref: ROUTES.BLOG,
        width: "content",
        align: "center",
        items: [{ label: "Blog", href: ROUTES.BLOG }, { label: "Post" }],
      };
    },
  },
  {
    id: "research-post",
    resolve: (pathname) => {
      if (
        !pathname.startsWith(`${ROUTES.RESEARCH}/`) ||
        pathname === ROUTES.RESEARCH_PROTOCOL
      )
        return undefined;
      return { backHref: ROUTES.RESEARCH, width: "content", align: "center", items: [] };
    },
  },
  {
    id: "kai-analysis-drill-in",
    resolve: (pathname, searchParams) => {
      if (pathname !== KAI_MARKET_PATH || searchParams?.get("tab") !== "analysis")
        return undefined;
      const analysisEntryId = String(searchParams?.get("analysis_id") || "").trim();
      const debateId = String(searchParams?.get("debate_id") || "").trim();
      const focus = String(searchParams?.get("focus") || "").trim();
      const runId = String(searchParams?.get("run_id") || "").trim();
      const ticker = String(searchParams?.get("ticker") || "").trim().toUpperCase();
      const view = String(searchParams?.get("view") || "").trim().toLowerCase();

      if (analysisEntryId || debateId) {
        return {
          backHref: ROUTES.KAI_ANALYSIS,
          width: "content",
          align: "center",
          items: [
            { label: "Finance", href: ROUTES.KAI_HOME },
            { label: "Stocks", href: ROUTES.KAI_ANALYSIS },
            { label: ticker ? `${ticker} analysis` : "Saved analysis" },
          ],
        };
      }
      if (focus === "active" || runId) {
        return {
          backHref: ROUTES.KAI_ANALYSIS,
          width: "content",
          align: "center",
          items: [
            { label: "Finance", href: ROUTES.KAI_HOME },
            { label: "Stocks", href: ROUTES.KAI_ANALYSIS },
            { label: ticker ? `${ticker} live` : "Active run" },
          ],
        };
      }
      if (ticker) {
        return {
          backHref: ROUTES.KAI_ANALYSIS,
          width: "content",
          align: "center",
          items: [
            { label: "Finance", href: ROUTES.KAI_HOME },
            { label: "Stocks", href: ROUTES.KAI_ANALYSIS },
            { label: `${ticker} preview` },
          ],
        };
      }
      if (view === "debate") {
        return {
          backHref: ROUTES.KAI_ANALYSIS,
          width: "content",
          align: "center",
          items: [
            { label: "Finance", href: ROUTES.KAI_HOME },
            { label: "Stocks", href: ROUTES.KAI_ANALYSIS },
            { label: "Debate" },
          ],
        };
      }
      // Base Analysis (bare `tab=analysis`, no drill-in param) falls through
      // to the kai-market-root node below, exactly like Market/Portfolio.
      return undefined;
    },
  },
  {
    id: "kai-market-root",
    resolve: (pathname, searchParams) => {
      if (pathname !== KAI_MARKET_PATH) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const setupBackHref = resolveCapabilitySetupBackHref(pathname, originHref);
      const fromSetup = originHref === ROUTES.ONE_SETUP;
      return {
        backHref: setupBackHref || ROUTES.ONE_HOME,
        width: "content",
        align: "center",
        suppressFallbackTitle: true,
        items: fromSetup ? [] : [{ label: "One", href: ROUTES.ONE_HOME }],
      };
    },
  },
  {
    id: "kai-news",
    resolve: (pathname) => {
      if (pathname !== ROUTES.KAI_NEWS) return undefined;
      return {
        backHref: ROUTES.KAI_HOME,
        width: "content",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Market", href: ROUTES.KAI_HOME },
          { label: "News" },
        ],
      };
    },
  },
  {
    id: "kai-portfolio-detail",
    resolve: (pathname) => {
      const portfolioDetailRoutes: Array<[string, string]> = [
        [ROUTES.KAI_PORTFOLIO_HOLDINGS, "Holdings"],
        [ROUTES.KAI_PORTFOLIO_ALLOCATION, "Allocation"],
        [ROUTES.KAI_PORTFOLIO_PERFORMANCE, "Performance"],
        [ROUTES.KAI_PORTFOLIO_SOURCES, "Portfolio source"],
      ];
      for (const [route, label] of portfolioDetailRoutes) {
        if (pathname === route) {
          return {
            backHref: ROUTES.KAI_PORTFOLIO,
            width: "content",
            align: "center",
            items: [
              { label: "One", href: ROUTES.ONE_HOME },
              { label: "Portfolio", href: ROUTES.KAI_PORTFOLIO },
              { label },
            ],
          };
        }
      }
      return undefined;
    },
  },
  {
    id: "ria-home",
    resolve: (pathname) => {
      if (pathname !== ROUTES.RIA_HOME && pathname !== ROUTES.RIA_PROFILE) return undefined;
      return { backHref: ROUTES.ONE_HOME, width: "content", align: "center", items: [] };
    },
  },
  {
    id: "ria-picks-exact",
    resolve: (pathname) => {
      if (pathname !== ROUTES.RIA_PICKS) return undefined;
      return { backHref: ROUTES.RIA_PROFILE, width: "content", align: "center", items: [] };
    },
  },
  {
    id: "ria-subroutes",
    resolve: (pathname) => {
      const riaSubroutes: Array<[string, string]> = [
        [ROUTES.RIA_PICKS, "Picks"],
        [ROUTES.RIA_WORKSPACE, "Workspace"],
        [ROUTES.RIA_REQUESTS, "Requests"],
        [ROUTES.RIA_SETTINGS, "Settings"],
      ];
      for (const [route, label] of riaSubroutes) {
        if (pathname === route || pathname.startsWith(`${route}/`)) {
          return {
            backHref: ROUTES.RIA_PROFILE,
            width: "content",
            align: "center",
            items: [
              { label: "One", href: ROUTES.ONE_HOME },
              { label: "Advisor", href: ROUTES.RIA_PROFILE },
              { label },
            ],
          };
        }
      }
      return undefined;
    },
  },
  {
    id: "ria-claim",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.RIA_CLAIM) return undefined;
      const returnHref =
        normalizeInternalRouteHref(searchParams?.get("return_to")) || ROUTES.RIA_ONBOARDING;
      return {
        backHref: returnHref,
        width: "content",
        align: "center",
        hideBack: false,
        items: [{ label: "Advisor", href: returnHref }, { label: "Claim profile" }],
      };
    },
  },
  {
    id: "ria-onboarding",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.RIA_ONBOARDING) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: originHref || ROUTES.ONE_HOME,
        width: "content",
        align: "center",
        items: [
          { label: "One", href: originHref || ROUTES.ONE_HOME },
          { label: "Setup" },
        ],
      };
    },
  },
  {
    id: "one-setup-kai",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.ONE_SETUP_KAI) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: originHref || ROUTES.ONE_SETUP,
        width: "content",
        align: "center",
        hideBack: false,
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Setup", href: ROUTES.ONE_SETUP },
        ],
      };
    },
  },
  {
    id: "kai-import",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.KAI_IMPORT && !pathname.startsWith(`${ROUTES.KAI_IMPORT}/`))
        return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: originHref || ROUTES.ONE_SETUP,
        width: "content",
        align: "center",
        hideBack: false,
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Setup", href: ROUTES.ONE_SETUP },
          { label: "Portfolio" },
        ],
      };
    },
  },
  {
    id: "one-setup-capability",
    resolve: (pathname, searchParams) => {
      if (!pathname.startsWith(`${ROUTES.ONE_SETUP}/`) || pathname === ROUTES.ONE_SETUP_KAI)
        return undefined;
      const capabilitySegment = pathname
        .slice(`${ROUTES.ONE_SETUP}/`.length)
        .split("/")
        .filter(Boolean)[0];
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const setupBackHref = originHref || ROUTES.ONE_SETUP;
      return {
        backHref: setupBackHref,
        width: "content",
        align: "center",
        hideBack: false,
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Setup", href: setupBackHref },
          ...(capabilitySegment
            ? [
                {
                  label:
                    getOneSetupCapability(capabilitySegment)?.title ??
                    titleizeSegment(capabilitySegment),
                },
              ]
            : []),
        ],
      };
    },
  },
  {
    id: "one-setup-hub",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.ONE_SETUP) return undefined;
      const returnHref =
        normalizeInternalRouteHref(searchParams?.get("return_to")) || ROUTES.HOME;
      return {
        backHref: returnHref,
        width: "content",
        align: "center",
        hideBack: true,
        items: [],
      };
    },
  },
  {
    id: "ria-clients-root",
    resolve: (pathname) => {
      if (pathname !== ROUTES.RIA_CLIENTS) return undefined;
      return { backHref: ROUTES.RIA_PROFILE, width: "profile", align: "center", items: [] };
    },
  },
  {
    id: "ria-clients-nested",
    resolve: (pathname) => {
      if (!pathname.startsWith(`${ROUTES.RIA_CLIENTS}/`)) return undefined;
      const nestedPath = pathname.slice(`${ROUTES.RIA_CLIENTS}/`.length);
      const segments = nestedPath.split("/").filter(Boolean);
      const clientId = segments[0];
      const primaryWorkspaceHref = clientId
        ? `${ROUTES.RIA_CLIENTS}/${encodeURIComponent(clientId)}`
        : ROUTES.RIA_CLIENTS;

      if (segments.length === 1) {
        return {
          backHref: ROUTES.RIA_CLIENTS,
          width: "profile",
          align: "center",
          items: [
            { label: "Advisor", href: ROUTES.RIA_PROFILE },
            { label: "Clients", href: ROUTES.RIA_CLIENTS },
            { label: "Workspace" },
          ],
        };
      }

      const section = segments[1];
      if (section === "accounts") {
        return {
          backHref: primaryWorkspaceHref,
          width: "profile",
          align: "center",
          items: [
            { label: "Advisor", href: ROUTES.RIA_PROFILE },
            { label: "Clients", href: ROUTES.RIA_CLIENTS },
            { label: "Workspace", href: primaryWorkspaceHref },
            { label: "Account detail" },
          ],
        };
      }
      if (section === "requests") {
        return {
          backHref: primaryWorkspaceHref,
          width: "profile",
          align: "center",
          items: [
            { label: "Advisor", href: ROUTES.RIA_PROFILE },
            { label: "Clients", href: ROUTES.RIA_CLIENTS },
            { label: "Workspace", href: primaryWorkspaceHref },
            { label: "Request detail" },
          ],
        };
      }
      // Unrecognized nested section: fall through (matches original — no
      // `return` fired in that branch, so the if-chain continued below).
      return undefined;
    },
  },
  {
    id: "consent-center",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.CONSENTS && pathname !== ROUTES.LEGACY_CONSENTS)
        return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const backHref = resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME;
      return {
        backHref,
        width: "profile",
        align: "center",
        suppressFallbackTitle: true,
        items: [{ label: "One", href: ROUTES.ONE_HOME }],
      };
    },
  },
  {
    id: "one-career",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_CAREER) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Career" }],
      };
    },
  },
  {
    id: "one-kyc",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.ONE_KYC) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const fromProfile = originHref === ROUTES.PROFILE;
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [
          fromProfile
            ? { label: "Profile", href: ROUTES.PROFILE }
            : { label: "One", href: ROUTES.ONE_HOME },
          { label: "KYC" },
        ],
      };
    },
  },
  {
    id: "one-location-map",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_LOCATION_MAP) return undefined;
      return {
        backHref: ROUTES.ONE_LOCATION,
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Location", href: ROUTES.ONE_LOCATION },
          { label: "Your Map" },
        ],
      };
    },
  },
  {
    id: "one-location",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.ONE_LOCATION) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const fromProfile = originHref === ROUTES.PROFILE;
      const action = String(searchParams?.get("action") || "").trim();

      if (action) {
        const returnToNearbyCheckIn =
          action === "private-check-in" && searchParams?.get("source") === "nearby";
        const nearbyReturnToken =
          searchParams?.get(NEARBY_PRIVATE_RETURN_TOKEN_PARAM) ?? null;
        const hubView = String(searchParams?.get("view") || "").trim();
        const smsContactsSource = searchParams?.get("source");

        if (
          (action === "sms-contacts" || action === "circle-detail") &&
          (smsContactsSource === "sos" || smsContactsSource === "settings")
        ) {
          return {
            backHref: `${ROUTES.ONE_LOCATION}?action=${resolveSmsContactsBackAction(smsContactsSource)}`,
            width: "profile",
            align: "center",
            items: [
              fromProfile
                ? { label: "Profile", href: ROUTES.PROFILE }
                : { label: "One", href: ROUTES.ONE_HOME },
              { label: "Location", href: ROUTES.ONE_LOCATION },
              {
                label: smsContactsSource === "sos" ? "Save My Soul" : "Settings",
                href: `${ROUTES.ONE_LOCATION}?action=${resolveSmsContactsBackAction(smsContactsSource)}`,
              },
              { label: "Emergency contacts" },
            ],
          };
        }

        const parentCircleId = searchParams?.get("circleId");
        const circleParentSource = searchParams?.get("parentSource");
        const circleParentSourceQuery =
          circleParentSource === "settings" || circleParentSource === "sos"
            ? `&source=${circleParentSource}`
            : "";
        const circleParentHref =
          (action === "share" || action === "ask") &&
          smsContactsSource === "circle" &&
          parentCircleId
            ? `${ROUTES.ONE_LOCATION}?action=circle-detail&circleId=${encodeURIComponent(parentCircleId)}&view=people${circleParentSourceQuery}`
            : null;
        const hubBackHref =
          action === "sms-contacts"
            ? `${ROUTES.ONE_LOCATION}?action=${resolveSmsContactsBackAction(searchParams?.get("source"))}`
            : `${ROUTES.ONE_LOCATION}?view=${encodeURIComponent(hubView || "now")}`;

        return {
          backHref:
            circleParentHref ||
            (returnToNearbyCheckIn
              ? isNearbyPrivateReturnToken(nearbyReturnToken)
                ? buildNearbyCheckInResumeHref(nearbyReturnToken)
                : ROUTES.ONE_LOCATION_CHECK_IN
              : hubBackHref),
          width: "profile",
          align: "center",
          items: [
            fromProfile
              ? { label: "Profile", href: ROUTES.PROFILE }
              : { label: "One", href: ROUTES.ONE_HOME },
            { label: "Location", href: ROUTES.ONE_LOCATION },
            { label: oneLocationActionLabel(action) },
          ],
        };
      }

      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [{ label: fromProfile ? "Profile" : "One" }],
      };
    },
  },
  {
    id: "one-wallet-card",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_WALLET_CARD) return undefined;
      return {
        backHref: ROUTES.PROFILE_ACCOUNT,
        width: "profile",
        align: "center",
        items: [
          { label: "Profile", href: ROUTES.PROFILE },
          { label: "Account", href: ROUTES.PROFILE_ACCOUNT },
          { label: "Apple Wallet" },
        ],
      };
    },
  },
  {
    id: "one-marketplace",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.ONE_MARKETPLACE) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const fromProfile = originHref === ROUTES.PROFILE;
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [
          fromProfile
            ? { label: "Profile", href: ROUTES.PROFILE }
            : { label: "One", href: ROUTES.ONE_HOME },
          { label: "Marketplace" },
        ],
      };
    },
  },
  {
    id: "one-feed",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.ONE_FEED) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const fromProfile = originHref === ROUTES.PROFILE;
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [
          fromProfile
            ? { label: "Profile", href: ROUTES.PROFILE }
            : { label: "One", href: ROUTES.ONE_HOME },
          { label: "Feed" },
        ],
      };
    },
  },
  {
    id: "gmail",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.GMAIL) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Mail" }],
      };
    },
  },
  {
    id: "calendar",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.CALENDAR) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Calendar" }],
      };
    },
  },
  {
    id: "one-todos",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_TODOS) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "To-do List" }],
      };
    },
  },
  {
    id: "pkm",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.PKM) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        suppressFallbackTitle: true,
        items: [{ label: "One", href: ROUTES.ONE_HOME }],
      };
    },
  },
  {
    id: "pkm-location",
    resolve: (pathname) => {
      if (pathname !== ROUTES.PKM_LOCATION && pathname !== ROUTES.PKM_LOCATION_DETAIL)
        return undefined;
      const detail = pathname === ROUTES.PKM_LOCATION_DETAIL;
      return {
        backHref: detail ? ROUTES.PKM_LOCATION : ROUTES.PKM,
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Memory", href: ROUTES.PKM },
          { label: "Location", ...(detail ? { href: ROUTES.PKM_LOCATION } : {}) },
          ...(detail ? [{ label: "Detail" }] : []),
        ],
      };
    },
  },
  {
    id: "pkm-recent",
    resolve: (pathname) => {
      if (pathname !== ROUTES.PKM_RECENT) return undefined;
      return {
        backHref: ROUTES.PKM,
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Memory", href: ROUTES.PKM },
          { label: "Recently learned" },
        ],
      };
    },
  },
  {
    id: "connected-systems-root",
    resolve: (pathname, searchParams, ctx) => {
      if (pathname !== ROUTES.CONNECTED_SYSTEMS) return undefined;
      const selectedSystemId = String(searchParams?.get("system") || "").trim();
      if (selectedSystemId) {
        const resolvedConnectedSystemLabel =
          String(ctx.connectedSystemLabel || "").trim() || "CRM";
        return {
          backHref: ROUTES.CONNECTED_SYSTEMS,
          width: "profile",
          align: "center",
          items: [
            { label: "One", href: ROUTES.ONE_HOME },
            { label: "Connected Systems", href: ROUTES.CONNECTED_SYSTEMS },
            { label: resolvedConnectedSystemLabel },
          ],
        };
      }
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      return {
        backHref: resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Connected Systems" },
        ],
      };
    },
  },
  {
    id: "connected-systems-nested",
    resolve: (pathname, _searchParams, ctx) => {
      if (!pathname.startsWith(`${ROUTES.CONNECTED_SYSTEMS}/`)) return undefined;
      const resolvedConnectedSystemLabel =
        String(ctx.connectedSystemLabel || "").trim() || "CRM";
      return {
        backHref: ROUTES.CONNECTED_SYSTEMS,
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Connected Systems", href: ROUTES.CONNECTED_SYSTEMS },
          { label: resolvedConnectedSystemLabel },
        ],
      };
    },
  },
  {
    id: "connect-circles-focused",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.CONNECT || searchParams?.get("tab") !== "circles")
        return undefined;
      const action = readConnectCircleAction(searchParams?.get("action") ?? null);
      const label = connectCircleTaskTitle(action);
      if (!label) return undefined; // falls through to connect-root below
      const isFocusedTask = action === "create-circle" || action === "join-circle";
      return {
        backHref: CONNECT_CIRCLES_LIST_HREF,
        backLabel: isFocusedTask ? "Back to Circles" : undefined,
        width: "profile",
        align: "center",
        hideBack: false,
        items: isFocusedTask
          ? [{ label }]
          : [
              { label: "One", href: ROUTES.ONE_HOME },
              { label: "Connect", href: CONNECT_CIRCLES_LIST_HREF },
              { label },
            ],
      };
    },
  },
  {
    id: "connect-root",
    resolve: (pathname) => {
      if (pathname !== ROUTES.CONNECT) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        hideBack: false,
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Connect" }],
      };
    },
  },
  {
    id: "people-detail",
    resolve: (pathname, searchParams) => {
      if (!pathname.startsWith("/people/")) return undefined;
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      if (!originHref) return null;
      return {
        backHref: originHref,
        width: "profile",
        align: "center",
        items: [
          { label: profileOriginCrumbLabel(originHref), href: originHref },
          { label: "Profile" },
        ],
      };
    },
  },
  {
    id: "marketplace-root",
    resolve: (pathname) => {
      if (pathname !== ROUTES.MARKETPLACE) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        hideBack: false,
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Connect" }],
      };
    },
  },
  {
    id: "marketplace-connections",
    resolve: (pathname) => {
      if (
        pathname !== ROUTES.MARKETPLACE_CONNECTIONS &&
        !pathname.startsWith(`${ROUTES.MARKETPLACE_CONNECTIONS}/`)
      )
        return undefined;
      const isPortfolio = pathname.includes("/portfolio");
      return {
        backHref: isPortfolio ? ROUTES.MARKETPLACE_CONNECTIONS : ROUTES.MARKETPLACE,
        width: "profile",
        align: "center",
        items: [
          { label: "Connect", href: ROUTES.MARKETPLACE },
          { label: "Connections", href: ROUTES.MARKETPLACE_CONNECTIONS },
          ...(isPortfolio ? [{ label: "Portfolio" }] : []),
        ],
      };
    },
  },
  {
    id: "profile-root",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.PROFILE) return undefined;
      const { panel, detail } = resolveProfileRouteState(pathname, searchParams);
      const panelLabel = profilePanelLabel(panel);
      const originBackHref = resolveProfileOriginBackHref(searchParams);
      const originParams = profileOriginSearchParams(searchParams);
      const profileRootHref = buildProfileRoute({ searchParams: originParams });

      if (!panelLabel) {
        return {
          backHref: originBackHref,
          width: "profile",
          align: "center",
          items: [{ label: profileOriginCrumbLabel(originBackHref), href: originBackHref }],
        };
      }

      const detailLabel = profileDetailLabel(detail);
      if (!panel) return null;
      const panelHref = buildProfileRoute({
        panel,
        searchParams: profileOriginSearchParams(searchParams),
      });
      return {
        backHref: detailLabel ? panelHref : profileRootHref,
        width: "profile",
        align: "center",
        items: [
          { label: "Profile", href: profileRootHref },
          { label: panelLabel, href: detailLabel ? panelHref : undefined },
          ...(detailLabel ? [{ label: detailLabel }] : []),
        ],
      };
    },
  },
  {
    id: "profile-not-nested",
    resolve: (pathname) => {
      // Primary catch-all: anything not under /one/profile/* (and not already
      // matched by an earlier, more specific node above) has no breadcrumb.
      if (!pathname.startsWith(`${ROUTES.PROFILE}/`)) return null;
      return undefined;
    },
  },
  {
    id: "profile-pkm",
    resolve: (pathname) => {
      if (pathname !== `${ROUTES.PROFILE}/pkm` && pathname !== `${ROUTES.PROFILE}/pkm-agent-lab`)
        return undefined;
      const memoryHref = profilePanelHref("my-data");
      return {
        backHref: memoryHref,
        width: "profile",
        align: "center",
        items: [
          { label: "Profile", href: memoryHref },
          { label: "Memory", href: memoryHref },
          { label: "PKM Agent" },
        ],
      };
    },
  },
  {
    id: "profile-access-connection",
    resolve: (pathname) => {
      if (pathname !== ROUTES.PROFILE_ACCESS_CONNECTION) return undefined;
      const memoryHref = profilePanelHref("my-data");
      const sharingHref = buildProfileRoute({ panel: "my-data", detail: "sharing" });
      return {
        backHref: sharingHref,
        width: "profile",
        align: "center",
        items: [
          { label: "Profile", href: ROUTES.PROFILE },
          { label: "Memory", href: memoryHref },
          { label: "Sharing", href: sharingHref },
          { label: "Connection detail" },
        ],
      };
    },
  },
  {
    id: "profile-voice-command-aliases",
    resolve: (pathname) => {
      if (
        pathname !== ROUTES.PROFILE_PREFERENCES_VOICE_CHANGELOG &&
        pathname !== ROUTES.PROFILE_PREFERENCES_VOICE_EXAMPLES
      )
        return undefined;
      const preferencesHref = profilePanelHref("preferences");
      return {
        backHref: preferencesHref,
        width: "profile",
        align: "center",
        items: [
          { label: "Profile", href: ROUTES.PROFILE },
          { label: "Preferences", href: preferencesHref },
          { label: "Location commands" },
        ],
      };
    },
  },
  {
    id: "profile-receipts",
    resolve: (pathname) => {
      if (pathname !== ROUTES.PROFILE_RECEIPTS) return undefined;
      return {
        backHref: ROUTES.GMAIL,
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Mail", href: ROUTES.GMAIL },
          { label: "Legacy receipts" },
        ],
      };
    },
  },
  {
    id: "profile-world-model",
    resolve: (pathname, searchParams) => {
      if (pathname !== ROUTES.PROFILE_WORLD_MODEL) return undefined;
      const parent = buildProfileRoute({ searchParams: profileOriginSearchParams(searchParams) });
      return { backHref: parent, width: "profile", align: "center", items: [
        { label: "Profile", href: parent }, { label: "Personal World Model" },
      ] };
    },
  },
  {
    id: "profile-generic-panel",
    resolve: (pathname, searchParams) => {
      // Final fallback for everything else under /one/profile/*.
      const { panel, detail } = resolveProfileRouteState(pathname, searchParams);
      const panelLabel = profilePanelLabel(panel);
      if (!panel || !panelLabel) return null;
      const detailLabel = profileDetailLabel(detail);
      const panelHref = buildProfileRoute({
        panel,
        searchParams: profileOriginSearchParams(searchParams),
      });
      return {
        backHref: detailLabel
          ? panelHref
          : buildProfileRoute({ searchParams: profileOriginSearchParams(searchParams) }),
        width: "profile",
        align: "center",
        items: [
          { label: "Profile", href: ROUTES.PROFILE },
          { label: panelLabel, href: detailLabel ? panelHref : undefined },
          ...(detailLabel ? [{ label: detailLabel }] : []),
        ],
      };
    },
  },
];

export function walkBackNavigationGraph(
  pathname: string,
  searchParams: SearchParamsLike,
  ctx: BackRuleContext,
): TopShellBreadcrumbConfig | null {
  const normalized = normalizeBreadcrumbPathname(pathname);
  for (const rule of BACK_NAVIGATION_RULES) {
    const result = rule.resolve(normalized, searchParams, ctx);
    if (result !== undefined) return result;
  }
  return null;
}
