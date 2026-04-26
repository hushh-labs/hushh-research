import { ROUTES } from "@/lib/navigation/routes";

export type TopShellBreadcrumbItem = {
  label: string;
  href?: string;
};

export type TopShellBreadcrumbConfig = {
  backHref: string;
  items: TopShellBreadcrumbItem[];
  width?: "content" | "profile";
  align?: "start" | "center";
};

function titleizeSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeInternalHref(value: string | null | undefined): string | null {
  const next = String(value || "").trim();
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  return next;
}

function profilePanelLabel(panel: string | null): string | null {
  if (panel === "my-data") return "My Data";
  if (panel === "access") return "Access & sharing";
  if (panel === "preferences") return "Preferences";
  if (panel === "security") return "Security";
  if (panel === "support") return "Support & feedback";
  if (panel === "gmail") return "Gmail receipts";
  return null;
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
  searchParams?: URLSearchParams | { get(name: string): string | null } | null
): TopShellBreadcrumbConfig | null {
  if (pathname === ROUTES.KAI_ANALYSIS) {
    const debateId = String(searchParams?.get("debate_id") || "").trim();
    const focus = String(searchParams?.get("focus") || "").trim();
    const runId = String(searchParams?.get("run_id") || "").trim();
    const ticker = String(searchParams?.get("ticker") || "").trim().toUpperCase();

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
  }

  if (pathname === ROUTES.RIA_CLIENTS) {
    return {
      backHref: ROUTES.RIA_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "RIA", href: ROUTES.RIA_HOME },
        { label: "Clients" },
      ],
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
    const originHref = normalizeInternalHref(searchParams?.get("from"));
    const privacyHref = `${ROUTES.PROFILE}?tab=privacy`;
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

  if (pathname === ROUTES.MARKETPLACE_CONNECTIONS || pathname.startsWith(`${ROUTES.MARKETPLACE_CONNECTIONS}/`)) {
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
  }

  if (pathname === ROUTES.PROFILE) {
    const panel = String(searchParams?.get("panel") || "").trim();
    const detail = String(searchParams?.get("detail") || "").trim();
    const panelLabel = profilePanelLabel(panel);
    if (!panelLabel) {
      return null;
    }

    const detailLabel = profileDetailLabel(detail);
    return {
      backHref: detailLabel ? `${ROUTES.PROFILE}?panel=${encodeURIComponent(panel)}` : ROUTES.PROFILE,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: panelLabel, href: detailLabel ? `${ROUTES.PROFILE}?panel=${encodeURIComponent(panel)}` : undefined },
        ...(detailLabel ? [{ label: detailLabel }] : []),
      ],
    };
  }

  if (!pathname.startsWith(`${ROUTES.PROFILE}/`)) {
    return null;
  }

  if (pathname === `${ROUTES.PROFILE}/pkm` || pathname === `${ROUTES.PROFILE}/pkm-agent-lab`) {
    const privacyHref = `${ROUTES.PROFILE}?tab=privacy`;
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
    backHref: `${ROUTES.PROFILE}?tab=account`,
    width: "profile",
    items: [
      { label: "Profile", href: `${ROUTES.PROFILE}?tab=account` },
      { label: titleizeSegment(firstSegment) },
      ...remainingSegments.map((segment) => ({ label: titleizeSegment(segment) })),
    ],
  };
}
