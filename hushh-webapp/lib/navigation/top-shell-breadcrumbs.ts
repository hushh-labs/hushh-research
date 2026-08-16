import {
  buildOneSetupCapabilityRoute,
  isOneSetupSurfaceRoute,
  KAI_MARKET_PATH,
  normalizeInternalRouteHref,
  resolveOnboardingCapabilityForRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { getOneSetupCapability } from "@/lib/onboarding/one-capabilities";
import { resolvePublicKnowledgeTopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import {
  buildProfileRoute,
  resolveProfileRouteState,
  type ProfilePanel,
} from "@/lib/navigation/profile-routes";
import {
  buildNearbyCheckInResumeHref,
  isNearbyPrivateReturnToken,
  NEARBY_PRIVATE_RETURN_TOKEN_PARAM,
} from "@/lib/one-location/nearby-private-navigation";

export type TopShellBreadcrumbItem = {
  label: string;
  href?: string;
};

export type TopShellBreadcrumbConfig = {
  backHref: string;
  items: TopShellBreadcrumbItem[];
  width?: "content" | "profile";
  align?: "start" | "center";
  /**
   * Suppress the top-bar back button for this route while keeping the rest of
   * the breadcrumb/title chrome. Used by the onboarding entry screen: until the
   * user has explicitly skipped or continued into a step, there is no confirmed
   * "previous" destination (back-before-/one would be logically wrong), so we
   * show no back affordance at all.
   */
  hideBack?: boolean;
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
function oneLocationActionLabel(action: string): string {
  const labels: Record<string, string> = {
    share: "Share location",
    // Sentence case, matching every sibling crumb ("Share location", "Active
    // shares", "Public link") and the screen's own TaskFlowHeader title. The
    // crumb and the title must read as the same words or the trail and the
    // screen stop agreeing.
    ask: "Request location",
    invite: "Invite to Circle",
    "temp-link": "Public link",
    "check-in": "Check-In",
    "private-check-in": "Private Check-In",
    "active-shares": "Active shares",
    "shared-with-me": "Shared with me",
    "needs-review": "Needs my review",
    // The crumb must match the on-screen title of the flow it names. The SOS
    // screen's TaskFlowHeader reads "Save my Soul", so the crumb does too — a
    // crumb saying "Safety" for a screen titled otherwise breaks the trail.
    sos: "Save my Soul",
    "sms-contacts": "SMS contacts",
    settings: "Settings",
    privacy: "Settings",
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
  if (panel === "access") return "Access & sharing";
  if (panel === "connected-systems") return "Connected Systems";
  if (panel === "preferences") return "Preferences";
  if (panel === "security") return "Security";
  if (panel === "support") return "Support & feedback";
  if (panel === "gmail") return "Gmail receipts";
  if (panel === "regulatory") return "Regulatory profile";
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
function resolveProfileOriginBackHref(
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
): string {
  return (
    normalizeInternalRouteHref(searchParams?.get("from")) ?? ROUTES.ONE_HOME
  );
}

/**
 * A clean, from-only params object so nested profile links keep the origin
 * without dragging transient vault/return markers into computed back hrefs.
 */
function profileOriginSearchParams(
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
): URLSearchParams | undefined {
  const from = normalizeInternalRouteHref(searchParams?.get("from"));
  return from ? new URLSearchParams({ from }) : undefined;
}

/** Human label for the origin the Profile hub was opened from. */
function profileOriginCrumbLabel(backHref: string): string {
  const path = normalizeBreadcrumbPathname(backHref);
  const labels: Record<string, string> = {
    [ROUTES.ONE_HOME]: "One",
    [ROUTES.ONE_LOCATION]: "Location",
    [ROUTES.GMAIL]: "Gmail",
    [ROUTES.PKM]: "Memory",
    [ROUTES.ONE_MARKETPLACE]: "Marketplace",
    [ROUTES.CONNECTED_SYSTEMS]: "Connected Systems",
    [ROUTES.CONSENTS]: "Consent Center",
    [ROUTES.ONE_FEED]: "Feed",
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
  if (detail === "appearance") return "Appearance";
  if (detail === "kai-preferences") return "Kai preferences";
  if (detail === "gemini") return "Gemini";
  if (detail === "device") return "On-device first";
  if (detail === "vault") return "Vault methods";
  if (detail === "session") return "Session";
  if (detail === "danger") return "Danger zone";
  if (detail === "gmail-connection") return "Connection";
  if (detail === "gmail-actions") return "Actions";
  if (detail === "support-routing") return "Routing";
  if (detail.startsWith("support-compose:")) return "Compose";
  return null;
}

function normalizeBreadcrumbPathname(pathname: string): string {
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

export interface ResolveTopShellBreadcrumbOptions {
  /**
   * True once the user has dismissed onboarding (finished/skipped setup, or the
   * backend/latch reports it). When set, a product/agent surface must never send
   * BACK into the setup funnel — stale `?from=/one/setup` markers and hardcoded
   * setup defaults are rewritten to ONE_HOME. Setup-internal pages keep their
   * retrace to the hub so the first onboarding pass is unchanged.
   */
  setupDismissed?: boolean;
  /** Public display metadata supplied by the loaded CRM registry. */
  connectedSystemLabel?: string | null;
}

export function resolveTopShellBreadcrumb(
  pathname: string,
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
  options?: ResolveTopShellBreadcrumbOptions,
): TopShellBreadcrumbConfig | null {
  const config = resolveTopShellBreadcrumbInner(
    pathname,
    searchParams,
    options?.connectedSystemLabel,
  );
  if (!config || !options?.setupDismissed) return config;
  // Once onboarding is dismissed, a product/agent surface must never send BACK
  // into the setup funnel. Setup-internal pages (the hub, connections, a
  // per-capability step) keep retracing to the hub; every other surface whose
  // back target resolves to a setup route (stale `?from=/one/setup`, hardcoded
  // defaults) is rerouted to home.
  const here = normalizeBreadcrumbPathname(pathname);
  if (isOneSetupSurfaceRoute(here)) return config;
  const backPath = config.backHref
    ? normalizeBreadcrumbPathname(config.backHref)
    : null;
  if (backPath && isOneSetupSurfaceRoute(backPath)) {
    return { ...config, backHref: ROUTES.ONE_HOME };
  }
  return config;
}

function resolveTopShellBreadcrumbInner(
  pathname: string,
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
  connectedSystemLabel?: string | null,
): TopShellBreadcrumbConfig | null {
  pathname = normalizeBreadcrumbPathname(pathname);
  const resolvedConnectedSystemLabel =
    String(connectedSystemLabel || "").trim() || "CRM";

  if (pathname === ROUTES.CONNECT_SETTINGS) {
    return {
      backHref: ROUTES.CONNECT,
      width: "content",
      align: "center",
      items: [{ label: "Connect", href: ROUTES.CONNECT }, { label: "Gemini" }],
    };
  }

  if (pathname === ROUTES.ONE_SETUP_CONNECTIONS) {
    return {
      backHref: ROUTES.ONE_SETUP,
      width: "content",
      align: "center",
      items: [
        { label: "Set up", href: ROUTES.ONE_SETUP },
        // Matches the on-screen title; a crumb that disagrees with the heading
        // reads as two different screens.
        { label: "Choose your AI" },
      ],
    };
  }

  // Welcome's tabs are peers, just like Finance and Location. The shared back
  // affordance exits the workspace to One; the tab strip and swipe pager own
  // movement between Research, Blog, and Developers.
  if (pathname === ROUTES.WELCOME) {
    const tabSet = resolvePublicKnowledgeTopShellTabSet(
      `${pathname}?tab=${searchParams?.get("tab") ?? ""}`,
    );
    if (!tabSet) return null;

    return {
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      hideBack: false,
      items: [],
    };
  }

  if (
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.RESEARCH ||
    pathname === ROUTES.BLOG ||
    pathname === ROUTES.RESEARCH_PROTOCOL
  ) {
    return {
      backHref: ROUTES.HOME,
      width: "content",
      align: "center",
      items: [],
    };
  }

  if (pathname.startsWith(`${ROUTES.BLOG}/`)) {
    return {
      backHref: ROUTES.BLOG,
      width: "content",
      align: "center",
      items: [{ label: "Blog", href: ROUTES.BLOG }, { label: "Post" }],
    };
  }

  if (
    pathname.startsWith(`${ROUTES.RESEARCH}/`) &&
    pathname !== ROUTES.RESEARCH_PROTOCOL
  ) {
    return {
      backHref: ROUTES.RESEARCH,
      width: "content",
      align: "center",
      items: [],
    };
  }

  if (pathname === KAI_MARKET_PATH && searchParams?.get("tab") === "analysis") {
    const analysisEntryId = String(searchParams?.get("analysis_id") || "").trim();
    const debateId = String(searchParams?.get("debate_id") || "").trim();
    const focus = String(searchParams?.get("focus") || "").trim();
    const runId = String(searchParams?.get("run_id") || "").trim();
    const ticker = String(searchParams?.get("ticker") || "")
      .trim()
      .toUpperCase();
    const view = String(searchParams?.get("view") || "")
      .trim()
      .toLowerCase();

    if (analysisEntryId || debateId) {
      return {
        backHref: ROUTES.KAI_ANALYSIS,
        width: "content",
        align: "center",
        items: [
          { label: "Finance", href: ROUTES.KAI_HOME },
          { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
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
          { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
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
          { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
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
          { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
          { label: "Debate" },
        ],
      };
    }

    return {
      // Market, Portfolio, and Analysis are peers in one query-tabbed Kai
      // workspace. Their base route returns to One, not to a different tab.
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Finance" }],
    };
  }

  if (pathname === KAI_MARKET_PATH) {
    // Origin-aware: when the user arrives here from account setup (the finance
    // capability forwards to the Kai wizard, which lands here on completion
    // carrying `?from=/one/setup`), back must retrace to the setup hub so they
    // can continue onboarding the other capabilities instead of being dropped
    // at One home with no path back.
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const setupBackHref = resolveCapabilitySetupBackHref(pathname, originHref);
    const fromSetup = originHref === ROUTES.ONE_SETUP;
    return {
      backHref: setupBackHref || ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [
        fromSetup
          ? { label: "Set up", href: ROUTES.ONE_SETUP }
          : { label: "One", href: ROUTES.ONE_HOME },
        { label: "Finance" },
      ],
    };
  }

  if (pathname === ROUTES.KAI_NEWS) {
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
  }

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

  // Profile is the RIA home. `/ria` remains a compatibility redirect only.
  if (pathname === ROUTES.RIA_HOME || pathname === ROUTES.RIA_PROFILE) {
    return {
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "RIA" },
        { label: "Profile" },
      ],
    };
  }

  // Debate config is a read-only sub-view of Picks (/ria/picks?view=debate):
  // it deepens one level below Picks, so back returns to Picks, not RIA home.
  // Checked before the generic riaSubroutes loop, which would otherwise match
  // the query-stripped /ria/picks pathname and flatten it to a 3-crumb Picks.
  if (
    (pathname === ROUTES.RIA_PICKS ||
      pathname.startsWith(`${ROUTES.RIA_PICKS}/`)) &&
    searchParams?.get("view") === "debate"
  ) {
    return {
      backHref: ROUTES.RIA_PICKS,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "RIA", href: ROUTES.RIA_PROFILE },
        { label: "Picks", href: ROUTES.RIA_PICKS },
        { label: "Debate" },
      ],
    };
  }

  // RIA subtabs (level 3): back returns to the RIA home (level 2).
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
          { label: "RIA", href: ROUTES.RIA_PROFILE },
          { label },
        ],
      };
    }
  }

  if (pathname === ROUTES.RIA_ONBOARDING) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      // RIA is an independently re-enterable sub-onboarding. Only an explicit
      // setup origin returns to the root setup hub; a bare RIA journey must
      // not reopen completed One setup just because the user presses Back.
      backHref: originHref || ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: originHref || ROUTES.ONE_HOME },
        { label: "Setup" },
      ],
    };
  }

  if (pathname === ROUTES.ONE_SETUP_KAI) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      // Re-entry (finance tile / edit) carries a `from` origin, so back returns
      // there; otherwise back falls to the setup hub.
      backHref: originHref || ROUTES.ONE_SETUP,
      width: "content",
      align: "center",
      // Show a back affordance when the user reached the wizard from a known
      // origin (the `from` marker set by the setup hub / finance tile re-entry)
      // OR fall back to the setup hub so the user is never trapped on the
      // questionnaire with no exit. Only the bare first-run entry with no origin
      // hides back, because navigating before /one/setup would bypass the
      // unfinished gate.
      hideBack: false,
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Setup", href: ROUTES.ONE_SETUP },
      ],
    };
  }

  if (
    pathname === ROUTES.KAI_IMPORT ||
    pathname.startsWith(`${ROUTES.KAI_IMPORT}/`)
  ) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      // Portfolio import is the final finance setup continuation. If the
      // wizard handed us an explicit origin, honor it; otherwise return to the
      // setup hub so the person is never trapped in the import flow.
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
  }

  // Per-capability setup step (`/one/setup/<capability>`, e.g. finance, gmail).
  // These live under the setup hub, so back returns to the hub and the user is
  // never trapped on a capability step with no exit. Checked before the bare
  // hub so the more specific nested route wins.
  if (
    pathname.startsWith(`${ROUTES.ONE_SETUP}/`) &&
    pathname !== ROUTES.ONE_SETUP_KAI
  ) {
    const capabilitySegment = pathname
      .slice(`${ROUTES.ONE_SETUP}/`.length)
      .split("/")
      .filter(Boolean)[0];
    return {
      backHref: ROUTES.ONE_SETUP,
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Setup", href: ROUTES.ONE_SETUP },
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
  }

  // The setup hub itself (`/one/setup`) follows completed phone verification.
  // There is no confirmed previous step in this root flow, so never offer a
  // top-shell path that can retrace a person into phone verification.
  if (pathname === ROUTES.ONE_SETUP) {
    const returnHref =
      normalizeInternalRouteHref(searchParams?.get("return_to")) || ROUTES.HOME;
    return {
      backHref: returnHref,
      width: "content",
      align: "center",
      hideBack: true,
      items: [{ label: "One", href: returnHref }, { label: "Setup" }],
    };
  }

  if (pathname === ROUTES.RIA_CLIENTS) {
    return {
      backHref: ROUTES.RIA_PROFILE,
      width: "profile",
      align: "center",
      items: [{ label: "RIA", href: ROUTES.RIA_PROFILE }, { label: "Clients" }],
    };
  }

  if (pathname.startsWith(`${ROUTES.RIA_CLIENTS}/`)) {
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
          { label: "RIA", href: ROUTES.RIA_PROFILE },
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
          { label: "RIA", href: ROUTES.RIA_PROFILE },
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
          { label: "RIA", href: ROUTES.RIA_PROFILE },
          { label: "Clients", href: ROUTES.RIA_CLIENTS },
          { label: "Workspace", href: primaryWorkspaceHref },
          { label: "Request detail" },
        ],
      };
    }
  }

  if (pathname === ROUTES.CONSENTS || pathname === ROUTES.LEGACY_CONSENTS) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const backHref =
      resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME;
    return {
      backHref,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Consent Center" },
      ],
    };
  }

  if (pathname === ROUTES.ONE_KYC) {
    // Origin-aware back: explicit safe origins retrace exactly; direct/cold
    // One capability entry falls back to the Agents dashboard.
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const fromProfile = originHref === ROUTES.PROFILE;
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        fromProfile
          ? { label: "Profile", href: ROUTES.PROFILE }
          : { label: "One", href: ROUTES.ONE_HOME },
        { label: "KYC" },
      ],
    };
  }

  if (pathname === ROUTES.ONE_LOCATION_MAP) {
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
  }

  if (pathname === ROUTES.ONE_LOCATION) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const fromProfile = originHref === ROUTES.PROFILE;
    // A Location action flow (Check-In, Alert, Share, Ask, Invite, Settings,
    // temporary link, or a focused detail view) is a
    // sub-screen of the Location hub, tracked via `?action=…`. While one is
    // open, the SINGLE top-left back button must return to the Location hub
    // (strip the action param) rather than leaving to /one. This is the only
    // back affordance on those screens — the in-content back arrows were
    // removed to fix the "two back buttons" UX.
    const action = String(searchParams?.get("action") || "").trim();
    if (action) {
      const returnToNearbyCheckIn =
        action === "private-check-in" &&
        searchParams?.get("source") === "nearby";
      const nearbyReturnToken =
        searchParams?.get(NEARBY_PRIVATE_RETURN_TOKEN_PARAM) ?? null;
      // Preserve the originating hub tab so the single top-bar (and OS/hardware)
      // back button returns the user to the tab the flow was opened FROM —
      // "Create a new link" from Links returns to Links, "Invite trusted person"
      // from People returns to People — instead of always dropping to the
      // default "Now" tab. `openFlow` keeps the current `?view=` tab in the URL
      // when it appends `?action=`, so it is available here. SMS contacts is
      // reached from Settings AND from the middle of an SOS, so it retraces to
      // whichever one opened it (see resolveSmsContactsBackAction).
      const hubView = String(searchParams?.get("view") || "").trim();
      const hubBackHref =
        action === "sms-contacts"
          ? `${ROUTES.ONE_LOCATION}?action=${resolveSmsContactsBackAction(
              searchParams?.get("source"),
            )}`
          : hubView
            ? `${ROUTES.ONE_LOCATION}?view=${encodeURIComponent(hubView)}`
            : ROUTES.ONE_LOCATION;
      return {
        backHref: returnToNearbyCheckIn
          ? isNearbyPrivateReturnToken(nearbyReturnToken)
            ? buildNearbyCheckInResumeHref(nearbyReturnToken)
            : `${ROUTES.ONE_LOCATION_MAP}?action=check-in`
          : hubBackHref,
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
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        fromProfile
          ? { label: "Profile", href: ROUTES.PROFILE }
          : { label: "One", href: ROUTES.ONE_HOME },
        { label: "Location" },
      ],
    };
  }

  if (pathname === ROUTES.ONE_MARKETPLACE) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const fromProfile = originHref === ROUTES.PROFILE;
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        fromProfile
          ? { label: "Profile", href: ROUTES.PROFILE }
          : { label: "One", href: ROUTES.ONE_HOME },
        { label: "Marketplace" },
      ],
    };
  }

  if (pathname === ROUTES.ONE_FEED) {
    // Feed is a bottom-nav destination but reads as a One sub-surface: the
    // shared top bar owns its "Feed" title + a single back-to-One arrow, so
    // the page itself carries no in-body header.
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const fromProfile = originHref === ROUTES.PROFILE;
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        fromProfile
          ? { label: "Profile", href: ROUTES.PROFILE }
          : { label: "One", href: ROUTES.ONE_HOME },
        { label: "Feed" },
      ],
    };
  }

  if (pathname === ROUTES.GMAIL) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Gmail" }],
    };
  }

  if (pathname === ROUTES.CALENDAR) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Calendar" }],
    };
  }

  if (pathname === ROUTES.PKM) {
    // Origin-aware so a setup-hub-opened surface (?from=/one/setup) retraces to
    // the hub; no marker → One home (unchanged).
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "PKM" }],
    };
  }

  if (pathname === ROUTES.CONNECTED_SYSTEMS) {
    const selectedSystemId = String(searchParams?.get("system") || "").trim();
    if (selectedSystemId) {
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

    // Origin-aware (see PKM above): setup-hub origin retraces to the hub.
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      backHref:
        resolveCapabilitySetupBackHref(pathname, originHref) || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Connected Systems" },
      ],
    };
  }

  if (pathname.startsWith(`${ROUTES.CONNECTED_SYSTEMS}/`)) {
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

  // Connect root (level 2): back returns to /one (level 1).
  if (pathname === ROUTES.CONNECT || pathname === ROUTES.MARKETPLACE) {
    return {
      backHref: ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      // Connect is a level-two workspace. Keep the shared shell back affordance
      // available so this entry behaves like the other One capability routes.
      hideBack: false,
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Connect" }],
    };
  }

  if (
    pathname === ROUTES.MARKETPLACE_CONNECTIONS ||
    pathname.startsWith(`${ROUTES.MARKETPLACE_CONNECTIONS}/`)
  ) {
    const isPortfolio = pathname.includes("/portfolio");
    return {
      backHref: isPortfolio
        ? ROUTES.MARKETPLACE_CONNECTIONS
        : ROUTES.MARKETPLACE,
      width: "profile",
      align: "center",
      items: [
        { label: "Connect", href: ROUTES.MARKETPLACE },
        { label: "Connections", href: ROUTES.MARKETPLACE_CONNECTIONS },
        ...(isPortfolio ? [{ label: "Portfolio" }] : []),
      ],
    };
  }

  if (pathname === ROUTES.PROFILE) {
    const { panel, detail } = resolveProfileRouteState(pathname, searchParams);
    const panelLabel = profilePanelLabel(panel);
    const originBackHref = resolveProfileOriginBackHref(searchParams);
    const originParams = profileOriginSearchParams(searchParams);
    // Keep the origin marker on the internal Profile back targets so drilling
    // Profile → panel → detail and stepping back never loses "where I came
    // from" once the user unwinds all the way to the Profile root.
    const profileRootHref = buildProfileRoute({ searchParams: originParams });
    if (!panelLabel) {
      // Bare profile root (level 2): back returns to the origin the avatar was
      // tapped from (origin-aware, like every other One capability). Falls back
      // to /one when there is no safe origin, preserving the historic default.
      return {
        backHref: originBackHref,
        width: "profile",
        align: "center",
        items: [
          {
            label: profileOriginCrumbLabel(originBackHref),
            href: originBackHref,
          },
          { label: "Profile" },
        ],
      };
    }

    const detailLabel = profileDetailLabel(detail);
    if (!panel) return null;
    const panelHref = profilePanelHref(panel);
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
  }

  if (!pathname.startsWith(`${ROUTES.PROFILE}/`)) {
    return null;
  }

  if (
    pathname === `${ROUTES.PROFILE}/pkm` ||
    pathname === `${ROUTES.PROFILE}/pkm-agent-lab`
  ) {
    const privacyHref = profilePanelHref("access");
    return {
      backHref: privacyHref,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: privacyHref },
        { label: "Privacy", href: privacyHref },
        { label: "PKM Agent" },
      ],
    };
  }

  if (pathname === ROUTES.PROFILE_RECEIPTS) {
    return {
      backHref: ROUTES.GMAIL,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Gmail", href: ROUTES.GMAIL },
        { label: "Legacy receipts" },
      ],
    };
  }

  const { panel, detail } = resolveProfileRouteState(pathname, searchParams);
  const panelLabel = profilePanelLabel(panel);
  if (!panel || !panelLabel) {
    return null;
  }
  const detailLabel = profileDetailLabel(detail);
  const panelHref = profilePanelHref(panel);

  return {
    backHref: detailLabel ? panelHref : ROUTES.PROFILE,
    width: "profile",
    align: "center",
    items: [
      { label: "Profile", href: ROUTES.PROFILE },
      { label: panelLabel, href: detailLabel ? panelHref : undefined },
      ...(detailLabel ? [{ label: detailLabel }] : []),
    ],
  };
}
