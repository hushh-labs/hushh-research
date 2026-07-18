import { KAI_MARKET_PATH, ROUTES } from "@/lib/navigation/routes";
import {
  buildConsentCenterHref,
  buildRiaConsentManagerHref,
} from "@/lib/consent/consent-sheet-route";
import { activeKaiRouteTabFromPath } from "@/lib/navigation/kai-route-tabs";
import { activeRiaRouteTabFromPath } from "@/lib/navigation/ria-route-tabs";

export type SharedBottomNavKey = "dashboard" | "connect" | "search" | "profile";
export type InvestorNavKey =
  SharedBottomNavKey | "finance" | "portfolio" | "connect" | "analysis";
export type RiaNavKey =
  SharedBottomNavKey | "ria-home" | "clients" | "connect" | "picks";
export type OneNavKey =
  | SharedBottomNavKey
  | "finance"
  | "gmail"
  | "email"
  | "location"
  | "guardian"
  | "pkm"
  | "marketplace"
  | "connected";
export type AppBottomNavKey = InvestorNavKey | RiaNavKey | OneNavKey;
export type AppBottomNavScope = "one" | "investor" | "ria";
export type AppBottomNavAction =
  | { type: "route"; href: string }
  | { type: "command"; mode: "search" }
  | { type: "none" };
export type AppBottomNavContext = {
  lastAgentNavScope?: AppBottomNavScope | null;
  lastAgentSectionId?: string | null;
};

export function normalizeBottomNavPathname(
  pathname: string | null | undefined,
): string {
  const base = pathname?.split(/[?#]/, 1)[0]?.replace(/\/$/, "") || "";
  return base === "" && pathname === "/" ? "/" : base;
}

function isBottomNavRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function isCommonBottomNavRoute(
  pathname: string | null | undefined,
): boolean {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  return (
    isBottomNavRoute(normalizedPathname, ROUTES.MARKETPLACE) ||
    isBottomNavRoute(normalizedPathname, ROUTES.CONNECT) ||
    isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)
  );
}

function isKnownBottomNavScope(
  value: AppBottomNavScope | null | undefined,
): value is AppBottomNavScope {
  return value === "one" || value === "investor" || value === "ria";
}

export function resolveBottomNavigationScope(
  pathname: string | null | undefined,
  _activePersona: string | null | undefined,
  context?: AppBottomNavContext,
): AppBottomNavScope {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  if (isBottomNavRoute(normalizedPathname, ROUTES.RIA_HOME)) {
    return "ria";
  }
  if (
    isBottomNavRoute(normalizedPathname, KAI_MARKET_PATH) ||
    isBottomNavRoute(normalizedPathname, ROUTES.LEGACY_KAI_HOME)
  ) {
    return "investor";
  }
  if (
    isCommonBottomNavRoute(normalizedPathname) &&
    isKnownBottomNavScope(context?.lastAgentNavScope)
  ) {
    return context.lastAgentNavScope;
  }
  return "one";
}

export function resolveOneNavSlot(
  pathname: string | null | undefined,
): OneNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  if (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.ONE_HOME
  ) {
    return "dashboard";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.CONNECT)) {
    return "connect";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.MARKETPLACE)) {
    return "connect";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.ONE_MARKETPLACE)) {
    return "marketplace";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.CONNECTED_SYSTEMS)) {
    return "connected";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.LEGACY_CONNECTED_SYSTEMS)) {
    return "connected";
  }
  if (normalizedPathname === ROUTES.ONE_KYC) return "email";
  if (
    normalizedPathname === ROUTES.GMAIL ||
    normalizedPathname === ROUTES.LEGACY_GMAIL ||
    normalizedPathname === ROUTES.PROFILE_RECEIPTS
  ) {
    return "gmail";
  }
  if (
    normalizedPathname === ROUTES.PKM ||
    normalizedPathname === ROUTES.LEGACY_PKM ||
    normalizedPathname === ROUTES.PROFILE ||
    normalizedPathname === ROUTES.PROFILE_PKM ||
    normalizedPathname === ROUTES.PROFILE_PKM_AGENT_LAB
  ) {
    return "pkm";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.ONE_LOCATION)) {
    return "location";
  }
  if (
    isBottomNavRoute(normalizedPathname, ROUTES.CONSENTS) ||
    isBottomNavRoute(normalizedPathname, ROUTES.LEGACY_CONSENTS)
  ) {
    return "guardian";
  }
  return "dashboard";
}

export function resolveOneActiveNav(
  pathname: string | null | undefined,
): OneNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  if (normalizedPathname === ROUTES.AGENT) return "search";
  if (isBottomNavRoute(normalizedPathname, ROUTES.CONNECT)) {
    return "connect";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.MARKETPLACE)) {
    return "connect";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)) {
    return "profile";
  }
  return resolveOneNavSlot(normalizedPathname);
}

export function resolveInvestorNavSlot(
  pathname: string | null | undefined,
): InvestorNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  const activeTab = activeKaiRouteTabFromPath(
    normalizedPathname || KAI_MARKET_PATH,
  );
  if (activeTab === "dashboard") return "portfolio";
  if (activeTab === "analysis") return "analysis";
  return "finance";
}

export function resolveInvestorActiveNav(
  pathname: string | null | undefined,
): InvestorNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  if (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.ONE_HOME
  ) {
    return "dashboard";
  }
  if (normalizedPathname === ROUTES.AGENT) return "search";
  if (isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)) {
    return "profile";
  }

  const activeTab = activeKaiRouteTabFromPath(
    normalizedPathname || KAI_MARKET_PATH,
  );
  if (activeTab === "market") return "finance";
  if (activeTab === "dashboard") return "portfolio";
  if (activeTab === "analysis") return "analysis";
  return "finance";
}

export function resolveRiaNavSlot(
  pathname: string | null | undefined,
): RiaNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  const activeTab = activeRiaRouteTabFromPath(
    normalizedPathname || ROUTES.RIA_HOME,
  );
  if (activeTab === "picks") return "picks";
  return "clients";
}

export function resolveRiaActiveNav(
  pathname: string | null | undefined,
): RiaNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  if (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.ONE_HOME
  ) {
    return "dashboard";
  }
  if (normalizedPathname === ROUTES.AGENT) return "search";
  if (isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)) {
    return "profile";
  }

  const activeTab = activeRiaRouteTabFromPath(
    normalizedPathname || ROUTES.RIA_HOME,
  );
  if (activeTab === "home") return "ria-home";
  if (activeTab === "clients") return "clients";
  if (activeTab === "picks") return "picks";
  return "ria-home";
}

export function resolveBottomNavActiveKey(
  pathname: string | null | undefined,
  _scope: AppBottomNavScope,
): AppBottomNavKey {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  if (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.ONE_HOME
  ) {
    return "dashboard";
  }
  if (normalizedPathname === ROUTES.AGENT) return "search";
  if (isBottomNavRoute(normalizedPathname, ROUTES.CONNECT)) {
    return "connect";
  }
  if (isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)) {
    // Profile is reached from One but is not a persistent bottom-bar option.
    // Keep the visible control selected rather than pointing at a removed tab.
    return "dashboard";
  }

  return "dashboard";
}

export function resolveBottomNavContextKey(
  pathname: string | null | undefined,
  scope: AppBottomNavScope,
): AppBottomNavKey {
  if (scope === "one") return resolveOneNavSlot(pathname);
  if (scope === "ria") return resolveRiaNavSlot(pathname);
  return resolveInvestorNavSlot(pathname);
}

export function resolveBottomNavOptionKeys(
  _pathname: string | null | undefined,
  _scope: AppBottomNavScope,
  _context?: AppBottomNavContext,
): AppBottomNavKey[] {
  return ["dashboard", "connect", "search"];
}

/** Contextual workspace tabs belong exclusively to the unified top shell. */
export function resolveBottomNavSpecialistOptionKeys(
  _scope: AppBottomNavScope,
): AppBottomNavKey[] {
  return [];
}

export function resolveBottomNavAction(
  value: AppBottomNavKey,
  scope: AppBottomNavScope,
): AppBottomNavAction {
  switch (value) {
    case "finance":
      return { type: "route", href: ROUTES.KAI_HOME };
    case "portfolio":
      return { type: "route", href: ROUTES.KAI_PORTFOLIO };
    case "dashboard":
      return { type: "route", href: ROUTES.ONE_HOME };
    case "search":
      return { type: "command", mode: "search" };
    case "gmail":
      return { type: "route", href: ROUTES.GMAIL };
    case "email":
      return { type: "route", href: ROUTES.ONE_KYC };
    case "location":
      return { type: "route", href: ROUTES.ONE_LOCATION };
    case "guardian":
      return {
        type: "route",
        href:
          scope === "ria"
            ? buildRiaConsentManagerHref("pending")
            : buildConsentCenterHref("pending"),
      };
    case "pkm":
      return { type: "route", href: ROUTES.PKM };
    case "marketplace":
      return { type: "route", href: ROUTES.ONE_MARKETPLACE };
    case "connected":
      return { type: "route", href: ROUTES.CONNECTED_SYSTEMS };
    case "analysis":
      return { type: "route", href: ROUTES.KAI_ANALYSIS };
    case "connect":
      return {
        type: "route",
        href: scope === "one" ? ROUTES.CONNECT : ROUTES.MARKETPLACE,
      };
    case "ria-home":
      return { type: "route", href: ROUTES.RIA_HOME };
    case "clients":
      return { type: "route", href: ROUTES.RIA_CLIENTS };
    case "picks":
      return { type: "route", href: ROUTES.RIA_PICKS };
    case "profile":
      // Unified profile for every scope, including RIA — the RIA advisor profile
      // now lives inside /profile under the "Regulatory profile" panel.
      return {
        type: "route",
        href: ROUTES.PROFILE,
      };
    default:
      return { type: "none" };
  }
}

export function resolveBottomNavHref(
  value: AppBottomNavKey,
  scope: AppBottomNavScope,
): string | null {
  const action = resolveBottomNavAction(value, scope);
  return action.type === "route" ? action.href : null;
}
