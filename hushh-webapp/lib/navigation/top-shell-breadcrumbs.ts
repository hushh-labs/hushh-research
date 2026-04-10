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

export function resolveTopShellBreadcrumb(
  pathname: string,
  searchParams?: URLSearchParams | { get(name: string): string | null } | null
): TopShellBreadcrumbConfig | null {
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

  if (pathname === ROUTES.PROFILE || !pathname.startsWith(`${ROUTES.PROFILE}/`)) {
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
