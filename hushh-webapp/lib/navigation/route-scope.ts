"use client";

import { ROUTES } from "@/lib/navigation/routes";
import type { Persona } from "@/lib/services/ria-service";

export type RouteScope = "investor" | "ria" | "shared" | "onboarding" | "public" | "unknown";

function isRoute(pathname: string, route: string) {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function getRouteScope(pathname: string): RouteScope {
  if (!pathname) return "unknown";

  if (isRoute(pathname, ROUTES.KAI_ONBOARDING) || isRoute(pathname, ROUTES.RIA_ONBOARDING)) {
    return "onboarding";
  }

  if (isRoute(pathname, ROUTES.KAI_HOME)) {
    return "investor";
  }

  if (isRoute(pathname, ROUTES.RIA_HOME)) {
    return "ria";
  }

  if (
    isRoute(pathname, ROUTES.CONSENTS) ||
    isRoute(pathname, ROUTES.ONE_LOCATION) ||
    isRoute(pathname, ROUTES.PROFILE) ||
    isRoute(pathname, ROUTES.MARKETPLACE)
  ) {
    return "shared";
  }

  if (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.LOGIN ||
    pathname === ROUTES.LOGOUT
  ) {
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
