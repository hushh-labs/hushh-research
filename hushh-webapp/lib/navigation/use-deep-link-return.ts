"use client";

/**
 * Route a Universal Link / App Link back into the running app.
 *
 * The OS half of this is a claim on both sides: `applinks:<domain>` in the iOS
 * entitlements plus a matching path in the served
 * `.well-known/apple-app-site-association`, and an `autoVerify` https intent
 * filter plus `.well-known/assetlinks.json` on Android. When those line up, the
 * system stops opening Safari or Chrome and hands the URL to the app instead.
 *
 * It hands it to the app as an event, not as navigation. Without this listener
 * the app would receive the OAuth return and simply sit on whatever screen it
 * was already showing, which reads to a person as "nothing happened" after they
 * finished connecting an account. This is the half that turns the handoff into
 * an arrival.
 *
 * Only same-origin paths are followed. An incoming URL is attacker-influenced
 * (anyone can send a link), so an origin that is not ours is ignored rather
 * than navigated to.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { APP_FRONTEND_ORIGIN } from "@/lib/config";

function knownOrigins(): string[] {
  const configured = String(APP_FRONTEND_ORIGIN || "").trim().replace(/\/+$/, "");
  const origins = [
    configured,
    "https://one.hushh.ai",
    "https://uat.one.hushh.ai",
    "https://dev.one.hushh.ai",
  ];
  return origins.filter(Boolean);
}

/** The in-app path to navigate to, or null when the URL is not ours to follow. */
export function resolveDeepLinkPath(rawUrl: string): string | null {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!knownOrigins().includes(origin)) return null;

  // Preserve the query and hash: an OAuth return carries its state there, and
  // dropping it would strand the flow just as surely as opening a browser.
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
}

export function useDeepLinkReturn(): void {
  const router = useRouter();

  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;

    void (async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform() || disposed) return;

      const { App } = await import("@capacitor/app");

      // A cold start opens the app directly on the link, so the event has
      // already fired by the time this mounts. Ask for it explicitly.
      try {
        const launch = await App.getLaunchUrl();
        const launchPath = launch?.url ? resolveDeepLinkPath(launch.url) : null;
        if (launchPath && !disposed) router.replace(launchPath);
      } catch {
        // A missing launch URL is the normal case, not a failure.
      }

      const handle = await App.addListener("appUrlOpen", (event) => {
        const path = resolveDeepLinkPath(event.url);
        if (path && !disposed) router.replace(path);
      });
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();
    })();

    return () => {
      disposed = true;
      remove?.();
    };
  }, [router]);
}
