"use client";

import { Capacitor } from "@capacitor/core";

import { APP_FRONTEND_ORIGIN } from "@/lib/config";
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

function toHttpsRedirectUrl(origin: string, path: string): string | undefined {
  const redirectUrl = toRedirectUrl(origin, path);
  if (!redirectUrl) return undefined;
  try {
    const parsed = new URL(redirectUrl);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function resolvePlaidRedirectUri(
  path: string = ROUTES.KAI_PLAID_OAUTH_RETURN
): string | undefined {
  const configuredOrigin = normalizeOrigin(APP_FRONTEND_ORIGIN);
  if (Capacitor.isNativePlatform()) {
    return toHttpsRedirectUrl(configuredOrigin, path);
  }

  if (typeof window !== "undefined") {
    const runtimeUrl = toHttpsRedirectUrl(window.location.origin, path);
    if (runtimeUrl) return runtimeUrl;
  }

  return toHttpsRedirectUrl(configuredOrigin, path);
}
