"use client";

import { ROUTES } from "@/lib/navigation/routes";

const LEGACY_PROFILE_GMAIL_OAUTH_RETURN = "/profile/gmail/oauth/return";

const TRUSTED_GMAIL_OAUTH_RETURN_HOSTS = new Set([
  "one.hushh.ai",
  "uat.one.hushh.ai",
  "dev.one.hushh.ai",
  "localhost",
  "127.0.0.1",
]);

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

function isGmailOAuthReturnPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return (
    normalized === normalizePathname(ROUTES.PROFILE_GMAIL_OAUTH_RETURN) ||
    normalized === normalizePathname(LEGACY_PROFILE_GMAIL_OAUTH_RETURN)
  );
}

export function resolveNativeGmailOAuthReturnHref(
  value: string | null | undefined,
): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const currentHost =
      typeof window === "undefined" ? "" : window.location.hostname;
    const trustedHost =
      TRUSTED_GMAIL_OAUTH_RETURN_HOSTS.has(url.hostname) ||
      (!!currentHost && url.hostname === currentHost);
    if (!trustedHost) return null;
    if (!isGmailOAuthReturnPath(url.pathname)) return null;
    return `${ROUTES.PROFILE_GMAIL_OAUTH_RETURN}${url.search}`;
  } catch {
    return null;
  }
}

export async function openNativeGmailOAuthUrl(url: string): Promise<boolean> {
  const authorizeUrl = String(url || "").trim();
  if (!authorizeUrl) return false;

  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: authorizeUrl });
    return true;
  } catch (error) {
    console.warn("[GmailOAuth] Native browser handoff failed:", error);
    return false;
  }
}

export async function closeNativeGmailOAuthBrowser(): Promise<void> {
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.close();
  } catch {
    // The browser may already be closed by the OS or by the user.
  }
}
