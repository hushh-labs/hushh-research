import {
  buildOneSetupCapabilityRoute,
  buildKaiMarketRoute,
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
    ask: "Ask someone",
    invite: "Invite to Circle",
    "temp-link": "Public link",
    "check-in": "Check-In",
    "drive-to": "Drive To",
    "pick-me-up": "Pick Me Up",
    "safe-arrival": "Safe Arrival",
    sos: "Safety",
    privacy: "Privacy",
  };
  return labels[action] ?? titleizeSegment(action);
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

function profileDetailLabel(detail: string | null): string | null {
  if (!detail) return null;
  if (detail.startsWith("domain:")) return "Domain detail";
  if (detail.startsWith("connection:")) return "Connection detail";
  if (detail === "appearance") return "Appearance";
  if (detail === "kai-preferences") return "Kai preferences";
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

export function resolveTopShellBreadcrumb(
  pathname: string,
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
): TopShellBreadcrumbConfig | null {
  pathname = normalizeBreadcrumbPathname(pathname);

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
      items: [{ label: "Set up", href: ROUTES.ONE_SETUP }, { label: "Connections" }],
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
    const debateId = String(searchParams?.get("debate_id") || "").trim();
    const focus = String(searchParams?.get("focus") || "").trim();
    const runId = String(searchParams?.get("run_id") || "").trim();
    const ticker = String(searchParams?.get("ticker") || "")
      .trim()
      .toUpperCase();

    if (debateId) {
      return {
        backHref: ROUTES.KAI_ANALYSIS,
        width: "content",
        align: "center",
        items: [
          { label: "Kai", href: ROUTES.KAI_HOME },
          { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
          { label: ticker ? `${ticker} run` : "Saved run" },
        ],
      };
    }

    if (focus === "active" || runId) {
      return {
        backHref: ROUTES.KAI_ANALYSIS,
        width: "content",
        align: "center",
        items: [
          { label: "Kai", href: ROUTES.KAI_HOME },
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
          { label: "Kai", href: ROUTES.KAI_HOME },
          { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
          { label: `${ticker} preview` },
        ],
      };
    }

    return {
      // Market, Portfolio, and Analysis are peers in one query-tabbed Kai
      // workspace. Their base route returns to One, not to a different tab.
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Kai" }],
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
        { label: "Kai" },
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

  // Kai finance subroutes (level 3): back returns to the Kai home (level 2),
  // which in turn returns to /one (level 1). Keeps the One -> agent -> subtab
  // hierarchy consistent instead of relying on browser history. The setup
  // origin is preserved on the Kai-home hop so the retrace can still reach the
  // setup hub from a subroute opened during onboarding.
  const kaiSubroutes: Array<[string, string]> = [
    [ROUTES.KAI_INVESTMENTS, "Investments"],
    [ROUTES.KAI_OPTIMIZE, "Optimize"],
    [ROUTES.KAI_FUNDING_TRADE, "Funding"],
  ];
  for (const [route, label] of kaiSubroutes) {
    if (pathname === route || pathname.startsWith(`${route}/`)) {
      const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
      const kaiHomeBack =
        originHref === ROUTES.ONE_SETUP
          ? buildKaiMarketRoute("market", { from: ROUTES.ONE_SETUP })
          : ROUTES.KAI_HOME;
      return {
        backHref: kaiHomeBack,
        width: "content",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "Kai", href: ROUTES.KAI_HOME },
          { label },
        ],
      };
    }
  }

  // RIA workspace home (level 2 for the adviser persona): back returns to /one.
  if (pathname === ROUTES.RIA_HOME) {
    return {
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "RIA" }],
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
        backHref: ROUTES.RIA_HOME,
        width: "content",
        align: "center",
        items: [
          { label: "One", href: ROUTES.ONE_HOME },
          { label: "RIA", href: ROUTES.RIA_HOME },
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

  // The setup hub itself (`/one/setup`). Back returns to the One home so a user
  // who opened setup from the dashboard can step out without completing it.
  if (pathname === ROUTES.ONE_SETUP) {
    const returnHref =
      normalizeInternalRouteHref(searchParams?.get("return_to")) || ROUTES.HOME;
    return {
      backHref: returnHref,
      width: "content",
      align: "center",
      hideBack: false,
      items: [{ label: "One", href: returnHref }, { label: "Setup" }],
    };
  }

  if (pathname === ROUTES.RIA_CLIENTS) {
    return {
      backHref: ROUTES.RIA_HOME,
      width: "profile",
      align: "center",
      items: [{ label: "RIA", href: ROUTES.RIA_HOME }, { label: "Clients" }],
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
          { label: "RIA", href: ROUTES.RIA_HOME },
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
          { label: "RIA", href: ROUTES.RIA_HOME },
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
          { label: "RIA", href: ROUTES.RIA_HOME },
          { label: "Clients", href: ROUTES.RIA_CLIENTS },
          { label: "Workspace", href: primaryWorkspaceHref },
          { label: "Request detail" },
        ],
      };
    }
  }

  if (pathname === ROUTES.CONSENTS || pathname === ROUTES.LEGACY_CONSENTS) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const privacyHref = profilePanelHref("access");
    const backHref =
      resolveCapabilitySetupBackHref(pathname, originHref) || privacyHref;
    return {
      backHref,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: privacyHref },
        { label: "Privacy", href: privacyHref },
        { label: "Consent center" },
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

  if (pathname === ROUTES.ONE_LOCATION) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const fromProfile = originHref === ROUTES.PROFILE;
    // A Location quick-action flow (Check-In, Drive To, Pick Me Up, Safe
    // Arrival, SOS/Alert, Share, Ask, Invite, Privacy, Temp link) is a
    // sub-screen of the Location hub, tracked via `?action=…`. While one is
    // open, the SINGLE top-left back button must return to the Location hub
    // (strip the action param) rather than leaving to /one. This is the only
    // back affordance on those screens — the in-content back arrows were
    // removed to fix the "two back buttons" UX.
    const action = String(searchParams?.get("action") || "").trim();
    if (action) {
      return {
        backHref: ROUTES.ONE_LOCATION,
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
          { label: "System detail" },
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
        { label: "System detail" },
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
    if (!panelLabel) {
      // Bare profile root (level 2): back returns to /one (level 1) so the
      // One -> Profile hierarchy always has a governed exit.
      return {
        backHref: ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Profile" }],
      };
    }

    const detailLabel = profileDetailLabel(detail);
    if (!panel) return null;
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
