"use client";

import { useCallback, useState } from "react";
import type { OneLocationOnboardingScreen } from "@/components/one-location/onboarding/one-location-onboarding-steps";

function readScreen(key: string | null): OneLocationOnboardingScreen {
  if (!key || typeof window === "undefined") return "features";
  try {
    const screen = window.sessionStorage.getItem(key);
    if (screen === "ready" || screen === "features") return screen;
    // A saved "place" checkpoint restarts at Features: the place draft is
    // memory-only, so a remounted editor must capture a fresh one.
  } catch {
    // Storage can be unavailable; mounted navigation still works.
  }
  return "features";
}

/** Resume after auth gates remount the route on share/app/tab return.
 * Only a screen name is retained, never contacts, codes, coordinates or keys.
 * Setup and workspace journeys are isolated, as are different accounts/tabs.
 */
export function useLocationOnboardingProgress(
  userId: string | null | undefined,
  mode: "setup" | "workspace",
) {
  const key = userId
    ? `one_location_onboarding_progress_v1:${mode}:${userId}`
    : null;
  const [entry, setEntry] = useState(() => ({ key, screen: readScreen(key) }));
  // Reset during render so an account change cannot render the previous
  // account's screen or overwrite its checkpoint with an initialization effect.
  if (entry.key !== key) setEntry({ key, screen: readScreen(key) });

  const setScreen = useCallback(
    (screen: OneLocationOnboardingScreen) => {
      setEntry({ key, screen });
      if (!key || typeof window === "undefined") return;
      try {
        // Write at the transition, before a share sheet can background the app.
        window.sessionStorage.setItem(key, screen);
      } catch {
        // Retain the in-memory screen when storage is blocked or full.
      }
    },
    [key],
  );

  const clearProgress = useCallback(() => {
    if (!key || typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Completion remains authoritative when storage is unavailable.
    }
  }, [key]);

  return { screen: entry.screen, setScreen, clearProgress };
}
