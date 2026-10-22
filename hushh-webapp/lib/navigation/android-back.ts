"use client";

import { useEffect } from "react";
import { dismissTopmostOverlay, registerBackLayer, unwindBackLayer } from "@/lib/navigation/back-layers";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

/**
 * One owner for the Android system Back gesture.
 *
 * Without a listener Capacitor calls `history.back()`, which knows nothing
 * about sheets: on the Galaxy S24 Ultra (2026-09-22) Back with a Consent
 * Center grant sheet open left Consent Center altogether, because the sheet is
 * driven by a replaced query param, not a history entry. Back now resolves in
 * this order:
 *
 *   1. an open sheet or dialog closes (topmost only), through its own Escape
 *      path, so a surface that deliberately refuses dismissal (the one-time
 *      recovery key) keeps refusing;
 *   2. a screen that owns Back (a full-screen map) handles it;
 *   3. the authored route parent handles it; at a root the app is minimised.
 */

export { dismissTopmostOverlay } from "@/lib/navigation/back-layers";

/** Compatibility entrypoint for the immersive map, now shared with shell Back. */
export function pushAndroidBackHandler(handler: () => void): () => void {
  return registerBackLayer({ pathname: window.location.pathname, depth: 100, back: () => { handler(); return true; } });
}

export function resolveAndroidBack(
  _canGoBack: boolean,
  actions: { navigateParent: () => boolean; minimize: () => void },
  doc: Document = document,
): "overlay" | "screen" | "parent" | "minimize" {
  if (dismissTopmostOverlay(doc)) return "overlay";
  if (unwindBackLayer(window.location.pathname, new URLSearchParams(window.location.search))) return "screen";
  if (actions.navigateParent()) return "parent";
  actions.minimize();
  return "minimize";
}

/** Mounted once, in the app providers. Inert on the web and on iOS. */
export function useAndroidBack(): void {
  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;

    void (async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (disposed || Capacitor.getPlatform() !== "android") return;
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("backButton", ({ canGoBack }) => {
        resolveAndroidBack(canGoBack, {
          navigateParent: () => navigateTopShellBack({
            pathname: window.location.pathname,
            searchParams: new URLSearchParams(window.location.search),
            navigate: action => { requestInternalAppNavigation({ href: action.href, replace: action.mode === "replace", scroll: false, source: "native_back", transitionMode: action.transitionMode }); },
          }),
          minimize: () => void App.minimizeApp(),
        });
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
  }, []);
}
