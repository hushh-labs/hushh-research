"use client";

import { useCallback } from "react";

import { OneLocationService } from "@/lib/one-location/service";
import { useSettingsReturn } from "@/lib/permissions/use-settings-return";

/**
 * Notice the moment someone un-blocks location, without making them tell us.
 *
 * The recovery instructions send a person out of the page and into settings.
 * Every second they spend back here wondering whether it worked is a second
 * the fix looks broken, and "now reload the page" is one instruction more than
 * they should have to carry.
 *
 * WHAT CHANGED, AND WHY IT MATTERED ON iOS
 *
 * This used to attach `visibilitychange` and `focus` itself, and nothing else.
 * Those are web signals; inside a Capacitor WKWebView they are not a reliable
 * app-lifecycle event, which is why every other surface in this app that cares
 * about coming back pairs them with Capacitor's `appStateChange`. So the one
 * path built to notice a return was the one path that could miss it on the
 * native build -- reported as "settings se aane ke baad ek back tap mein app
 * par switch nahi karwa rha", where the missing half was not the switch back
 * but the app doing nothing once it happened.
 *
 * The signals now live in {@link useSettingsReturn}, which contacts uses too:
 * one answer to "they went to the OS, tell me when they are back", rather than
 * a second copy per permission that drifts from this one.
 */
export function useLocationPermissionHealing(params: {
  /** Only watch while the person is actually stuck. */
  enabled: boolean;
  /** Called once, when permission is observed to have become usable. */
  onGranted: () => void;
}): void {
  const { enabled, onGranted } = params;

  const readGranted = useCallback(async () => {
    const permission = await OneLocationService.getPermissionState();
    return permission?.state === "granted";
  }, []);

  useSettingsReturn({
    enabled,
    readGranted,
    onRestored: onGranted,
    // Chromium fires this the instant the site's Location switch flips, even
    // while the tab sits in the background. Safari does not implement it and
    // rejects, which is why it is an addition rather than the mechanism.
    permissionName: "geolocation",
  });
}
