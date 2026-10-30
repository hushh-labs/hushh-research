"use client";

import { ROUTES } from "@/lib/navigation/routes";
import type { Persona } from "@/lib/services/ria-service";

export type RouteScope =
  | "investor"
  | "ria"
  | "shared"
  | "onboarding"
  | "public"
  | "unknown";

function isRoute(pathname: string, route: string) {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function getRouteScope(pathname: string): RouteScope {
  if (!pathname) return "unknown";

  if (
    isRoute(pathname, ROUTES.ONE_ONBOARDING) ||
    isRoute(pathname, ROUTES.LEGACY_ONE_KAI_ONBOARDING) ||
    isRoute(pathname, ROUTES.LEGACY_KAI_ONBOARDING) ||
    isRoute(pathname, ROUTES.RIA_ONBOARDING)
  ) {
    return "onboarding";
  }

  if (isRoute(pathname, ROUTES.KAI_HOME) || isRoute(pathname, ROUTES.LEGACY_KAI_HOME)) {
    return "investor";
  }

  if (isRoute(pathname, ROUTES.RIA_HOME)) {
    return "ria";
  }

  if (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.ONE_HOME ||
    isRoute(pathname, ROUTES.AGENT) ||
    isRoute(pathname, ROUTES.CONSENTS) ||
    isRoute(pathname, ROUTES.GMAIL) ||
    isRoute(pathname, ROUTES.LEGACY_GMAIL) ||
    isRoute(pathname, ROUTES.PKM) ||
    isRoute(pathname, ROUTES.LEGACY_PKM) ||
    isRoute(pathname, ROUTES.CONNECTED_SYSTEMS) ||
    isRoute(pathname, ROUTES.LEGACY_CONNECTED_SYSTEMS) ||
    isRoute(pathname, ROUTES.ONE_KYC) ||
    isRoute(pathname, ROUTES.ONE_LOCATION) ||
    isRoute(pathname, ROUTES.PROFILE) ||
    isRoute(pathname, ROUTES.MARKETPLACE)
  ) {
    return "shared";
  }

  if (pathname === ROUTES.LOGIN || pathname === ROUTES.LOGOUT) {
    return "public";
  }

  return "unknown";
}

export function isPersonaScopedRoute(pathname: string): boolean {
  const scope = getRouteScope(pathname);
  return scope === "investor" || scope === "ria";
}

export function routePersonaForScope(scope: RouteScope): Persona | null {
  if (scope === "investor") return "investor";
  if (scope === "ria") return "ria";
  return null;
}
