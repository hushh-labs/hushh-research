import { normalizeInternalRouteHref, ROUTES } from "@/lib/navigation/routes";

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

function profilePanelLabel(panel: string | null): string | null {
  if (panel === "account") return "Account";
  if (panel === "my-data") return "My Data";
  if (panel === "access") return "Access & sharing";
  if (panel === "connected-systems") return "Connected Systems";
  if (panel === "preferences") return "Preferences";
  if (panel === "security") return "Security";
  if (panel === "support") return "Support & feedback";
  if (panel === "gmail") return "Gmail receipts";
  return null;
}

function profilePanelFromParams(
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
): string {
  const panel = String(searchParams?.get("panel") || "").trim();
  if (panel) return panel;

  const tab = String(searchParams?.get("tab") || "").trim();
  if (tab === "privacy") return "access";
  return tab;
}

function profilePanelHref(panel: string): string {
  return `${ROUTES.PROFILE}?panel=${encodeURIComponent(panel)}`;
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

export function resolveTopShellBreadcrumb(
  pathname: string,
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
): TopShellBreadcrumbConfig | null {
  if (pathname === ROUTES.KAI_ANALYSIS) {
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
      backHref: ROUTES.KAI_HOME,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Kai", href: ROUTES.KAI_HOME },
        { label: "Analysis" },
      ],
    };
  }

  if (pathname === ROUTES.KAI_HOME) {
    return {
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Kai" },
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
          ? [{ label: titleizeSegment(capabilitySegment) }]
          : []),
      ],
    };
  }

  // The setup hub itself (`/one/setup`). Back returns to the One home so a user
  // who opened setup from the dashboard can step out without completing it.
  if (pathname === ROUTES.ONE_SETUP) {
    return {
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Setup" },
      ],
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

  if (pathname === ROUTES.CONSENTS) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    const privacyHref = profilePanelHref("access");
    const backHref = originHref || privacyHref;
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
    return {
      backHref: ROUTES.PROFILE,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: "Email" },
      ],
    };
  }

  if (pathname === ROUTES.ONE_LOCATION) {
    return {
      backHref: ROUTES.PROFILE,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: "Location" },
      ],
    };
  }

  if (pathname === ROUTES.GMAIL) {
    const originHref = normalizeInternalRouteHref(searchParams?.get("from"));
    return {
      backHref: originHref || ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Gmail" },
      ],
    };
  }

  if (pathname === ROUTES.PKM) {
    return {
      backHref: ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "PKM" },
      ],
    };
  }

  if (pathname === ROUTES.CONNECTED_SYSTEMS) {
    return {
      backHref: ROUTES.ONE_HOME,
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
    const panel = profilePanelFromParams(searchParams);
    const detail = String(searchParams?.get("detail") || "").trim();
    const panelLabel = profilePanelLabel(panel);
    if (!panelLabel) {
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

  const nestedPath = pathname.slice(`${ROUTES.PROFILE}/`.length);
  const segments = nestedPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const [firstSegment, ...remainingSegments] = segments;
  if (!firstSegment) {
    return null;
  }

  return {
    backHref: profilePanelHref("account"),
    width: "profile",
    items: [
      { label: "Profile", href: profilePanelHref("account") },
      { label: titleizeSegment(firstSegment) },
      ...remainingSegments.map((segment) => ({
        label: titleizeSegment(segment),
      })),
    ],
  };
}
