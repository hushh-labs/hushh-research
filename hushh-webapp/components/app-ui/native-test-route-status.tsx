"use client";

import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { getNativeTestConfig } from "@/lib/testing/native-test";

function normalizeRoute(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return trimmed || "/";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
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

  if (!config.enabled || !marker) {
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
