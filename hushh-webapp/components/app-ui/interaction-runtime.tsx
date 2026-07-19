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

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        appInteractionCoordinator.handleLifecycle("background");
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (Capacitor.isNativePlatform()) {
      void import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("appStateChange", ({ isActive }) => {
            appInteractionCoordinator.handleLifecycle(
              isActive ? "active" : "background",
            );
          }),
        )
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
