"use client";

import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { getNativeTestConfig } from "@/lib/testing/native-test";

// 1. Added explicit return type for cleaner TypeScript
function normalizeRoute(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed || trimmed === "/") return trimmed || "/";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function NativeTestRouteStatus() {
  // Hooks must be called unconditionally at the top level
  const pathname = usePathname();
  const { user, loading } = useAuth();

  const config = getNativeTestConfig();
  const marker = config.expectedMarker?.trim();

  // 2. Performance: Early return BEFORE doing string manipulations
  if (!config.enabled || !marker) {
    return null;
  }

  const currentRoute = normalizeRoute(pathname);
  const expectedRoute = normalizeRoute(config.expectedRoute);

  const authState = loading ? "pending" : user ? "authenticated" : "anonymous";
  const dataState = loading ? "loading" : "loaded";

  return (
    <div
      className="hidden" // 3. Replaced inline style with Tailwind class
      aria-hidden="true"
      data-testid={marker}
      data-native-route-marker="true"
      data-native-route-id={expectedRoute || currentRoute}
      data-native-auth-default={authState}
      data-native-data-default={dataState}
    />
  );
}