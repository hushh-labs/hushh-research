import { ROUTES } from "@/lib/navigation/routes";

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
}

export const APP_ROUTE_LAYOUT_CONTRACT: readonly AppRouteLayoutContractEntry[] = [
  { route: ROUTES.HOME, mode: "hidden", exemptionReason: "Public landing route uses chrome-free marketing layout." },
  {
    route: ROUTES.DEVELOPERS,
    mode: "standard",
    shellVerification: {
      file: "components/developers/developer-docs-hub.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion"],
    },
  },
  { route: ROUTES.LOGIN, mode: "hidden", exemptionReason: "Auth-only route intentionally bypasses the signed-in app shell." },
  { route: ROUTES.LOGOUT, mode: "hidden", exemptionReason: "Logout route is a transitional auth screen, not a standard content page." },
  { route: "/portfolio/shared", mode: "hidden", exemptionReason: "Shared portfolio snapshot route is a public read-only view with dedicated chrome-free layout." },
  { route: ROUTES.LABS_PROFILE_APPEARANCE, mode: "hidden", exemptionReason: "Labs route is intentionally isolated from the primary app shell." },
  { route: ROUTES.CONSENTS, mode: "redirect", exemptionReason: "Compatibility alias routes into the shared consent sheet instead of rendering a standalone page." },
  {
    route: ROUTES.KAI_HOME,
    mode: "standard",
    shellVerification: {
      file: "components/kai/views/kai-market-preview-view.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.KAI_ANALYSIS,
    mode: "standard",
    shellVerification: {
      file: "app/kai/analysis/page.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  { route: "/kai/dashboard", mode: "redirect", exemptionReason: "Compatibility redirect route only launches the canonical portfolio/dashboard entry." },
  {
    route: "/kai/dashboard/analysis",
    mode: "redirect",
    exemptionReason: "Compatibility redirect route only launches the canonical analysis entry.",
    shellVerification: {
      file: "app/kai/dashboard/analysis/page.tsx",
      includes: ["AppPageShell"],
    },
  },
  {
    route: ROUTES.KAI_IMPORT,
    mode: "standard",
    shellVerification: {
      file: "app/kai/import/page.tsx",
      includes: ["AppPageShell", "AppPageContentRegion"],
    },
  },
  {
    route: ROUTES.KAI_INVESTMENTS,
    mode: "standard",
    shellVerification: {
      file: "components/kai/views/investments-master-view.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.KAI_ONBOARDING,
    mode: "flow",
    exemptionReason: "Fullscreen onboarding flow owns its own shell and safe-area spacing.",
  },
  {
    route: ROUTES.KAI_OPTIMIZE,
    mode: "standard",
    shellVerification: {
      file: "app/kai/optimize/page.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack", "PageHeader"],
    },
  },
  {
    route: ROUTES.KAI_PLAID_OAUTH_RETURN,
    mode: "standard",
    shellVerification: {
      file: "app/kai/plaid/oauth/return/page.tsx",
      includes: ["AppPageShell", "AppPageContentRegion"],
    },
  },
  {
    route: ROUTES.KAI_PORTFOLIO,
    mode: "standard",
    shellVerification: {
      file: "app/kai/portfolio/page.tsx",
      includes: ["AppPageShell", "AppPageContentRegion"],
    },
  },
  {
    route: ROUTES.MARKETPLACE,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.MARKETPLACE_RIA_PROFILE,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.PROFILE,
    mode: "standard",
    shellVerification: {
      file: "app/profile/page.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "PageHeader", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.PROFILE_PKM,
    mode: "standard",
    shellVerification: {
      file: "app/profile/pkm/page.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "PageHeader", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.PROFILE_PKM_AGENT_LAB,
    mode: "standard",
    shellVerification: {
      file: "app/profile/pkm-agent-lab/page.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "PageHeader", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.PROFILE_RECEIPTS,
    mode: "standard",
    shellVerification: {
      file: "app/profile/receipts/page.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "PageHeader", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.PROFILE_GMAIL_OAUTH_RETURN,
    mode: "standard",
    shellVerification: {
      file: "app/profile/gmail/oauth/return/page.tsx",
      includes: ["AppPageShell", "AppPageContentRegion"],
    },
  },
  {
    route: ROUTES.RIA_HOME,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.RIA_CLIENTS,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.RIA_ONBOARDING,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.RIA_PICKS,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
  {
    route: ROUTES.RIA_REQUESTS,
    mode: "redirect",
    exemptionReason: "Compatibility alias routes into the shared consent workspace.",
  },
  {
    route: ROUTES.RIA_SETTINGS,
    mode: "redirect",
    exemptionReason: "Compatibility alias routes into the canonical profile/settings surface.",
  },
  {
    route: ROUTES.RIA_WORKSPACE,
    mode: "standard",
    shellVerification: {
      file: "components/ria/ria-page-shell.tsx",
      includes: ["AppPageShell", "AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"],
    },
  },
] as const;

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
