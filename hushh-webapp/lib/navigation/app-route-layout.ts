import contractEntries from "@/lib/navigation/app-route-layout.contract.json";

export type AppRouteLayoutMode = "standard" | "flow" | "redirect" | "hidden";

export interface AppRouteShellVerification {
  file: string;
  includes: readonly string[];
}

export type AppRouteVoiceProactivity = "on_entry" | "ambient";
export type AppRouteVoiceReturnPolicy =
  | "stay"
  | "navigate"
  | "external_callback"
  | "return_to_hub"
  | "resolve_root";

export interface AppRouteVoicePlaybook {
  playbookId: string;
  purpose: string;
  screen: string;
  entryCue: string;
  proactivity: AppRouteVoiceProactivity;
  primaryActionId: string | null;
  happyPathActionIds: readonly string[];
  requiredInputs: readonly string[];
  recoveries: {
    blocked: string;
    cancelled: string;
    failed: string;
    timeout: string;
    callbackError: string;
    routeMismatch: string;
  };
  completionBoundary: string;
  nextRoute: string | null;
  returnPolicy: AppRouteVoiceReturnPolicy;
  outOfScopeBehavior: string;
}

export interface AppRouteLayoutContractEntry {
  route: string;
  mode: AppRouteLayoutMode;
  voicePlaybook: AppRouteVoicePlaybook;
  shellVerification?: AppRouteShellVerification;
  exemptionReason?: string;
  pageTopLocalOffset?: string;
}

export const APP_ROUTE_LAYOUT_CONTRACT =
  contractEntries as readonly AppRouteLayoutContractEntry[];

const DEFAULT_ROUTE_LAYOUT: AppRouteLayoutContractEntry = {
  route: "*",
  mode: "standard",
  voicePlaybook: {
    playbookId: "route.unknown",
    purpose: "Remain conversational without proposing unavailable controls.",
    screen: "unknown",
    entryCue: "",
    proactivity: "ambient",
    primaryActionId: null,
    happyPathActionIds: [],
    requiredInputs: [],
    recoveries: {
      blocked: "Explain that the current control is unavailable.",
      cancelled: "Respect the cancellation and remain on the current screen.",
      failed: "Acknowledge the failure without claiming completion.",
      timeout: "Retain the goal and offer a safe retry.",
      callbackError: "Retain the goal and explain the callback failed.",
      routeMismatch: "Use the verified current route before offering an action.",
    },
    completionBoundary: "No action completes without browser settlement.",
    nextRoute: null,
    returnPolicy: "stay",
    outOfScopeBehavior: "Answer normally and do not invent a control.",
  },
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
  const normalized = normalizePathname(pathname);
  return APP_ROUTE_LAYOUT_CONTRACT.find((entry) => entry.route === normalized) ??
    APP_ROUTE_LAYOUT_CONTRACT.find((entry) => matchRoutePattern(normalized, entry.route)) ??
    DEFAULT_ROUTE_LAYOUT;
}

export function resolveAppRouteLayoutMode(pathname: string): AppRouteLayoutMode {
  return resolveAppRouteLayout(pathname).mode;
}
