import { ROUTES } from "@/lib/navigation/routes";

export type TopShellBreadcrumbItem = {
  label: string;
  href?: string;
};

export type TopShellBreadcrumbConfig = {
  backHref: string;
  items: TopShellBreadcrumbItem[];
};

function titleizeSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveTopShellBreadcrumb(pathname: string): TopShellBreadcrumbConfig | null {
  if (pathname === ROUTES.PROFILE || !pathname.startsWith(`${ROUTES.PROFILE}/`)) {
    return null;
  }

  if (pathname === `${ROUTES.PROFILE}/pkm` || pathname === `${ROUTES.PROFILE}/pkm-agent-lab`) {
    return {
      backHref: `${ROUTES.PROFILE}?tab=account`,
      items: [
        { label: "Profile", href: `${ROUTES.PROFILE}?tab=account` },
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
    items: [
      { label: "Profile", href: `${ROUTES.PROFILE}?tab=account` },
      { label: titleizeSegment(firstSegment) },
      ...remainingSegments.map((segment) => ({ label: titleizeSegment(segment) })),
    ],
  };
}
