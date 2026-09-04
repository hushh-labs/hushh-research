"use client";

import { useEffect } from "react";

import { isNative } from "@/lib/capacitor/platform";

/**
 * Notice the moment somebody comes back from the OS settings app, and whether
 * what they went there to switch on is now on.
 *
 * WHY THIS EXISTS
 *
 * Reported, after testing an iOS build:
 *
 *   "settings ios wali jab bhi open ho rahin, either for syncing contacts or
 *    this settings, ek back tap mein app par switch nahi karwa rha -- mereko
 *    application back mein dekh kar kholna pda"
 *
 *   "baaki ke apps ... settings mein desired operation enable/disable karne ke
 *    baad entry ka path bhi dete hain ... ham kyun nhi kr paa rhe"
 *
 * The status-bar "‹ Back to Hussh" pill is iOS's to draw and nothing in this
 * repository can force it. What IS ours is everything after the person gets
 * back, and that half was broken in a way that made the whole trip feel like a
 * dead end: they returned to the same screen, in the same blocked state, with
 * the toast that sent them gone, and had to find and press the same button
 * again. Whether or not iOS drew a pill, the app did nothing with their return.
 *
 * THE BUG THIS FIXES
 *
 * `use-location-permission-healing` already tried to do this and listens to
 * `visibilitychange` and `focus` only. Inside a Capacitor WKWebView those are
 * not reliable app-lifecycle signals -- which is why every other surface in
 * this app that cares about coming back (`location-immersive-map`,
 * `app-ui/interaction-runtime`) pairs them with Capacitor's `appStateChange`.
 * The healing hook did not, so on the native build the one path designed to
 * notice a return was the one path that could miss it.
 *
 * All three signals here, because no single one covers every surface:
 *
 * 1. **`appStateChange`** — the native truth. The only signal that reliably
 *    fires when an iOS app is foregrounded from Settings.
 * 2. **`visibilitychange` / `focus`** — the web truth, and a harmless second
 *    opinion on native.
 * 3. **`PermissionStatus.onchange`** — exact, where the browser implements it.
 *    Chromium fires it the instant the switch flips, even in the background.
 *    WebKit rejects the query outright, which is why it cannot be the only one.
 *
 * This hook only ever READS. It cannot prompt, capture, or write, so nothing
 * here can act behind the person's back -- it observes, and hands the decision
 * to its caller.
 */
export function useSettingsReturn(params: {
  /** Only watch while the person is actually waiting on something. */
  enabled: boolean;
  /**
   * Is the thing they went to switch on now on? Resolves false (never throws)
   * when it cannot be read -- an unreadable permission is not a recovery.
   */
  readGranted: () => Promise<boolean>;
  /** Fires at most once, when `readGranted` first answers true. */
  onRestored: () => void;
  /**
   * Optional live signal for browsers that implement it. Omit for permissions
   * the Permissions API does not name (contacts has no entry).
   */
  permissionName?: string;
}): void {
  const { enabled, readGranted, onRestored, permissionName } = params;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    let settled = false;
    let status: PermissionStatus | null = null;
    let removeAppListener: (() => void) | null = null;

    // Once. A second call would re-enter the caller's work while the first is
    // still running -- on iOS that spends a prompt, and for a contact sync it
    // starts a second pass over the address book.
    const restore = () => {
      if (cancelled || settled) return;
      settled = true;
      onRestored();
    };

    const check = async () => {
      if (cancelled || settled) return;
      try {
        if (await readGranted()) restore();
      } catch {
        // Unreadable is not a failure to recover from. The person can still
        // press the button, and the next signal will try again.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // The native lifecycle signal. Dynamically imported for the same reason
    // `interaction-runtime` does it: the web bundle must not carry it.
    if (isNative()) {
      void import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("appStateChange", ({ isActive }) => {
            if (isActive) void check();
          }),
        )
        .then((handle) => {
          if (cancelled) {
            void handle.remove();
            return;
          }
          removeAppListener = () => void handle.remove();
        })
        .catch(() => {
          // The DOM listeners above remain the fallback.
        });
    }

    void (async () => {
      if (!permissionName) return;
      try {
        const query = navigator.permissions?.query;
        if (!query) return;
        const next = await navigator.permissions.query({
          name: permissionName as PermissionName,
        });
        if (cancelled) return;
        status = next;
        // Already fixed before this mounted -- they switched it on and then
        // navigated back rather than switching apps.
        if (next.state === "granted") {
          restore();
          return;
        }
        next.onchange = () => {
          if (next.state === "granted") restore();
        };
      } catch {
        // WebKit rejects unknown names. The listeners above are the whole
        // recovery path there, and they are already attached.
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      removeAppListener?.();
      if (status) status.onchange = null;
    };
  }, [enabled, readGranted, onRestored, permissionName]);
}
