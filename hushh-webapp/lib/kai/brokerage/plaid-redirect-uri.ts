"use client";

import { Capacitor } from "@capacitor/core";

import { FRONTEND_URL } from "@/lib/config";
import { ROUTES } from "@/lib/navigation/routes";

function normalizeOrigin(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function toRedirectUrl(origin: string, path: string): string | undefined {
  const cleanedOrigin = normalizeOrigin(origin);
  if (!cleanedOrigin) return undefined;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  try {
    return new URL(normalizedPath, `${cleanedOrigin}/`).toString();
  } catch {
    return undefined;
  }
}

export function resolvePlaidRedirectUri(
  path: string = ROUTES.KAI_PLAID_OAUTH_RETURN
): string | undefined {
  const configuredOrigin = normalizeOrigin(FRONTEND_URL);
  if (Capacitor.isNativePlatform()) {
    return toRedirectUrl(configuredOrigin, path);
  }

  if (typeof window !== "undefined") {
    const runtimeUrl = toRedirectUrl(window.location.origin, path);
    if (runtimeUrl) return runtimeUrl;
  }

  return toRedirectUrl(configuredOrigin, path);
}
