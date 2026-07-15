"use client";

import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { getNativeTestConfig } from "@/lib/testing/native-test";

const GLOBAL_STATUS_FALLBACK_MARKERS = new Set([
  "native-route-home",
  "native-route-kai-home",
]);
const COMPATIBILITY_REDIRECT_FALLBACK_MARKERS = new Set([
  "native-route-consents",
  "native-route-kai-analysis",
  "native-route-kai-portfolio",
  "native-route-profile-pkm",
]);

function normalizeRoute(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return trimmed || "/";
  try {
    const url = new URL(trimmed, "https://native-test.local");
    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${pathname}${url.search}`;
  } catch {
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

function getRedirectTarget(route: string | null | undefined) {
  if (!route) return null;
  try {
    return new URL(route, "https://native-test.local").searchParams.get("redirect");
  } catch {
    return null;
  }
}

function shouldUseFallbackMarker(params: {
  marker: string;
  expectedRoute: string;
  initialRoute: string | null;
  currentRoute: string;
}) {
  if (GLOBAL_STATUS_FALLBACK_MARKERS.has(params.marker)) {
    return true;
  }

  const redirectTarget = normalizeRoute(getRedirectTarget(params.initialRoute));
  const isCompatibilityRedirect =
    Boolean(redirectTarget) &&
    Boolean(params.expectedRoute) &&
    redirectTarget !== params.expectedRoute &&
    params.currentRoute === params.expectedRoute;

  return (
    isCompatibilityRedirect &&
    COMPATIBILITY_REDIRECT_FALLBACK_MARKERS.has(params.marker)
  );
}

export function NativeTestRouteStatus() {
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const config = getNativeTestConfig();
  const currentRoute = normalizeRoute(pathname);
  const expectedRoute = normalizeRoute(config.expectedRoute);
  const marker = config.expectedMarker || "";
  const authState = loading ? "pending" : user ? "authenticated" : "anonymous";
  const dataState = loading ? "loading" : "loaded";

  if (
    !config.enabled ||
    !marker ||
    !shouldUseFallbackMarker({
      marker,
      expectedRoute,
      initialRoute: config.initialRoute,
      currentRoute,
    })
  ) {
    return null;
  }

  return (
    <div
      style={{ display: "none" }}
      aria-hidden="true"
      data-testid={marker}
      data-native-route-marker="true"
      data-native-route-id={expectedRoute || currentRoute}
      data-native-auth-default={authState}
      data-native-data-default={dataState}
    />
  );
}
