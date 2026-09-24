"use client";

import { useEffect } from "react";

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
 *   3. history goes back, and with none left the app is minimised, not quit.
 */

type BackHandler = () => void;

const screenHandlers: BackHandler[] = [];

/**
 * Lets a screen own Back while it is mounted; the most recent registration
 * wins. Returns the unregister function.
 */
export function pushAndroidBackHandler(handler: BackHandler): () => void {
  screenHandlers.push(handler);
  return () => {
    const index = screenHandlers.lastIndexOf(handler);
    if (index >= 0) screenHandlers.splice(index, 1);
  };
}

const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Sends Escape to the topmost open sheet or dialog. Radix listens for Escape on
 * the document and only its highest layer reacts, so exactly one surface
 * closes, and one that prevents Escape stays open. True when one was open.
 */
export function dismissTopmostOverlay(doc: Document = document): boolean {
  const open = doc.querySelectorAll<HTMLElement>(OPEN_OVERLAY_SELECTOR);
  const top = open[open.length - 1];
  if (!top) return false;
  const active = doc.activeElement;
  const target = active instanceof HTMLElement && top.contains(active) ? active : top;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}

export function resolveAndroidBack(
  canGoBack: boolean,
  actions: { goBack: () => void; minimize: () => void },
  doc: Document = document,
): "overlay" | "screen" | "history" | "minimize" {
  if (dismissTopmostOverlay(doc)) return "overlay";
  const screenHandler = screenHandlers[screenHandlers.length - 1];
  if (screenHandler) {
    screenHandler();
    return "screen";
  }
  if (canGoBack) {
    actions.goBack();
    return "history";
  }
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
          goBack: () => window.history.back(),
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
