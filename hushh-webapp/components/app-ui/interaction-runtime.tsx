"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

/**
 * One app-level lifecycle adapter. Native hosts publish lifecycle events, but
 * React remains the interaction owner; VaultProvider separately owns whether a
 * valid vault session must be locked on resume.
 */
export function InteractionRuntime(): null {
  useEffect(() => {
    let removeNativeListener: (() => void) | null = null;
    let cancelled = false;

    const isNative = Capacitor.isNativePlatform();

    const onVisibilityChange = () => {
      // On native this event cannot tell a glance from a background. iOS hides
      // the WebView when the notification shade or Control Center comes down,
      // so `visibilityState === "hidden"` fires for a two-second look at your
      // notifications exactly as it does for leaving the app. Native lifecycle
      // is owned by `pause`/`resume` below; this listener stays for the web,
      // where the event means what it says.
      if (isNative) return;
      appInteractionCoordinator.handleLifecycle(
        document.visibilityState === "hidden" ? "background" : "active",
      );
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (isNative) {
      void import("@capacitor/app")
        .then(({ App }) => {
          // `pause`/`resume`, NOT `appStateChange`.
          //
          // Capacitor maps appStateChange isActive:false to
          // UIApplication.willResignActiveNotification, which iOS posts for the
          // notification shade, Control Center, an incoming call banner and the
          // app switcher preview -- none of which are backgrounding. That is why
          // pulling the shade down and coming back re-ran a full session check
          // behind the loading gate every time.
          //
          // `pause` and `resume` map to didEnterBackground and
          // willEnterForeground, which fire only when the app genuinely leaves
          // and returns. Verified against the plugin source in
          // node_modules/@capacitor/app/ios/Sources/AppPlugin/AppPlugin.swift.
          const pause = App.addListener("pause", () => {
            appInteractionCoordinator.handleLifecycle("background");
          });
          const resume = App.addListener("resume", () => {
            appInteractionCoordinator.handleLifecycle("active");
          });
          return Promise.all([pause, resume]).then((handles) => ({
            remove: () => {
              for (const handle of handles) void handle.remove();
            },
          }));
        })
        .then((handle) => {
          if (cancelled) {
            void handle.remove();
            return;
          }
          removeNativeListener = () => void handle.remove();
        })
        .catch(() => {
          // Browser visibility still provides the safe fallback.
        });
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      removeNativeListener?.();
    };
  }, []);

  return null;
}
