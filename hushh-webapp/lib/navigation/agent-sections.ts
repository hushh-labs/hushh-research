import { Briefcase, LayoutDashboard, type LucideIcon } from "lucide-react";

import {
  ONE_CAPABILITIES,
  type OneCapability,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import { ROUTES } from "@/lib/navigation/routes";
import type { AppBottomNavScope } from "@/lib/navigation/app-bottom-nav";

export type AgentSectionRouteFamily = "one" | "investor" | "ria";

export interface AgentSection {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  routeFamily: AgentSectionRouteFamily;
  bottomNavScope: AppBottomNavScope;
  screenId: string;
  controlId: string;
  tone?: OneCapabilityTone;
  voiceRouteActionId?: string;
}

export interface AgentNavigationContext {
  scope: AppBottomNavScope;
  sectionId: string | null;
}

const AGENT_SECTION_OVERRIDES: Record<
  string,
  Pick<
    AgentSection,
    "routeFamily" | "bottomNavScope" | "screenId" | "voiceRouteActionId"
  >
> = {
  finance: {
    routeFamily: "investor",
    bottomNavScope: "investor",
    screenId: "kai_market",
    voiceRouteActionId: "route.kai_home",
  },
  gmail: {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "gmail",
    voiceRouteActionId: "route.profile_receipts",
  },
  email: {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "one_kyc",
    voiceRouteActionId: "route.one_kyc",
  },
  location: {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "one_location",
    voiceRouteActionId: "route.one_location",
  },
  pkm: {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "pkm",
    voiceRouteActionId: "route.one_pkm",
  },
  consent: {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "consents",
    voiceRouteActionId: "route.consents",
  },
  marketplace: {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "one_marketplace",
    voiceRouteActionId: "route.one_marketplace",
  },
  "connected-systems": {
    routeFamily: "one",
    bottomNavScope: "one",
    screenId: "connected_systems",
    voiceRouteActionId: "route.profile_connected_systems",
  },
};

const AGENTS_ROOT_SECTION: AgentSection = {
  id: "agents",
  label: "One",
  href: ROUTES.ONE_HOME,
  icon: LayoutDashboard,
  routeFamily: "one",
  bottomNavScope: "one",
  screenId: "one_agents",
  controlId: "top_agent_section_dropdown",
  voiceRouteActionId: "route.one_agents",
};

// Finance ships as two standalone top-level agents in the product: Investor
// (/one/kai) and RIA (/ria). Kai remains the INTERNAL finance runtime naming
// (routes, contracts, code identifiers) and is not surfaced as a product
// agent. /ria self-guards: non-RIA users are redirected to RIA onboarding by
// app/ria/page.tsx, so exposing the entry here is safe.
const RIA_WORKSPACE_SECTION: AgentSection = {
  id: "ria",
  label: "RIA",
  href: ROUTES.RIA_HOME,
  icon: Briefcase,
  routeFamily: "ria",
  bottomNavScope: "ria",
  screenId: "ria_home",
  controlId: "top_agent_section_ria",
  voiceRouteActionId: "route.ria_home",
};

// Finance onboarding is still a Finance surface even though its route lives
// under `/one/setup`. Without these aliases the shared dropdown falls back to
// the root One selection while a person is completing Finance preferences or
// choosing a portfolio source.
const AGENT_SECTION_ROUTE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  finance: [
    ROUTES.ONE_SETUP_FINANCE,
    ROUTES.ONE_SETUP_FINANCE_IMPORT,
    ROUTES.KAI_PLAID_OAUTH_RETURN,
  ],
};

function normalizePathname(value: string | null | undefined): string {
  const raw =
    String(value ?? "")
      .split(/[?#]/, 1)[0]
      ?.trim() || "/";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withSlash === "/") return "/";
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function normalizeHrefPathname(value: string): string {
  return normalizePathname(value);
}

function isRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function toAgentSection(capability: OneCapability): AgentSection {
  const override = AGENT_SECTION_OVERRIDES[capability.id] ?? {
    routeFamily: "one" as const,
    bottomNavScope: "one" as const,
    screenId: capability.id,
    voiceRouteActionId: undefined,
  };

  return {
    id: capability.id,
    label: capability.title,
    href: capability.href,
    icon: capability.icon,
    tone: capability.tone,
    routeFamily: override.routeFamily,
    bottomNavScope: override.bottomNavScope,
    screenId: override.screenId,
    controlId: `top_agent_section_${capability.id}`,
    voiceRouteActionId: override.voiceRouteActionId,
  };
}

export function getAgentSections(): readonly AgentSection[] {
  const sections = ONE_CAPABILITIES.filter(
    (capability) =>
      capability.id !== "ria" && capability.isVisibleOnRoster !== false,
  ).map(toAgentSection);
  // RIA sits directly after Investor so the two finance personas stay
  // adjacent while remaining standalone top-level agents.
  const financeIndex = sections.findIndex(
    (section) => section.id === "finance",
  );
  if (financeIndex >= 0) {
    sections.splice(financeIndex + 1, 0, RIA_WORKSPACE_SECTION);
  } else {
    sections.push(RIA_WORKSPACE_SECTION);
  }
  // One is the relationship-level app and the first destination in the
  // selector. Specialist apps follow it; the durable internal id stays
  // `agents` for generated voice/action compatibility.
  return [AGENTS_ROOT_SECTION, ...sections];
}

export function getAgentSection(
  id: string | null | undefined,
): AgentSection | null {
  if (!id) return null;
  if (id === AGENTS_ROOT_SECTION.id) return AGENTS_ROOT_SECTION;
  return getAgentSections().find((section) => section.id === id) ?? null;
}

export function getAgentsRootSection(): AgentSection {
  return AGENTS_ROOT_SECTION;
}

export function resolveAgentSectionForPath(
  pathname: string | null | undefined,
): AgentSection | null {
  const normalizedPathname = normalizePathname(pathname);

  if (normalizedPathname === ROUTES.ONE_HOME) {
    return AGENTS_ROOT_SECTION;
  }

  for (const section of getAgentSections()) {
    if (section.id === AGENTS_ROOT_SECTION.id) continue;
    const sectionPaths = [
      section.href,
      ...(AGENT_SECTION_ROUTE_ALIASES[section.id] || []),
    ];
    if (
      sectionPaths.some((path) =>
        isRoute(normalizedPathname, normalizeHrefPathname(path)),
      )
    ) {
      return section;
    }
  }

  return null;
}

export function resolveAgentNavigationContextForPath(
  pathname: string | null | undefined,
): AgentNavigationContext | null {
  const normalizedPathname = normalizePathname(pathname);
  const section = resolveAgentSectionForPath(normalizedPathname);

  if (section) {
    return {
      scope: section.bottomNavScope,
      sectionId: section.id,
    };
  }

  if (
    normalizedPathname === ROUTES.HOME ||
    normalizedPathname === ROUTES.ONE_HOME
  ) {
    return {
      scope: "one",
      sectionId: null,
    };
  }

  if (isRoute(normalizedPathname, ROUTES.RIA_HOME)) {
    return {
      scope: "ria",
      sectionId: null,
    };
  }

  return null;
}
