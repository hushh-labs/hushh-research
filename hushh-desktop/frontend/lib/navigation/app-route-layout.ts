import contractEntries from "@/lib/navigation/app-route-layout.contract.json";

export type AppRouteLayoutMode = "standard" | "flow" | "redirect" | "hidden";

export interface AppRouteShellVerification {
  file: string;
  includes: readonly string[];
}

export interface AppRouteLayoutContractEntry {
  route: string;
  mode: AppRouteLayoutMode;
  shellVerification?: AppRouteShellVerification;
  exemptionReason?: string;
  pageTopLocalOffset?: string;
}

export const APP_ROUTE_LAYOUT_CONTRACT =
  contractEntries as readonly AppRouteLayoutContractEntry[];

const DEFAULT_ROUTE_LAYOUT: AppRouteLayoutContractEntry = {
  route: "*",
  mode: "standard",
};

function normalizePathname(pathname: string): string {
  const trimmed = pathname.split(/[?#]/, 1)[0]?.trim() || "/";
  if (trimmed === "/") return "/";
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function matchRoutePattern(pathname: string, routePattern: string): boolean {
  const normalizedPath = normalizePathname(pathname);
  if (routePattern === "/") return normalizedPath === "/";

  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const patternSegments = routePattern.split("/").filter(Boolean);

  if (pathSegments.length !== patternSegments.length) return false;

  return patternSegments.every((patternSegment, index) => {
    if (isDynamicSegment(patternSegment)) {
      return Boolean(pathSegments[index]);
    }
    return patternSegment === pathSegments[index];
  });
}

export function resolveAppRouteLayout(pathname: string): AppRouteLayoutContractEntry {
  return (
    APP_ROUTE_LAYOUT_CONTRACT.find((entry) => matchRoutePattern(pathname, entry.route)) ??
    DEFAULT_ROUTE_LAYOUT
  );
}

export function resolveAppRouteLayoutMode(pathname: string): AppRouteLayoutMode {
  return resolveAppRouteLayout(pathname).mode;
}
