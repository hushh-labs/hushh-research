"use client";

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import {
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";

const STORAGE_PREFIX = "hushh.one_setup_complete.v1.";

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * User-scoped, positive-only setup admission hint.
 *
 * This contains no journey details or vault material. It only avoids blocking
 * a returning user on a setup check that has already resolved durably. An
 * authoritative incomplete response clears it, and sign-out/account deletion
 * remove it through UserLocalStateService.
 *
 * On native iOS the WebView runs under a custom scheme (`iosScheme: "App"`)
 * where WKWebView evicts localStorage across app launches (see mobile-bug-log
 * B18). localStorage alone would lose this latch on every relaunch and re-trap
 * a resolved user on the setup hub, so the flag is mirrored into the durable
 * native store (Capacitor Preferences / UserDefaults) and rehydrated on cold
 * start via `hydrateFromNative`. Web keeps using localStorage only, so desktop
 * behaviour is unchanged.
 */
export class OneSetupCompletionHintService {
  static isResolved(userId: string): boolean {
    if (!userId) return false;
    return getLocalItem(storageKey(userId)) === "1";
  }

  static markResolved(userId: string): void {
    if (!userId) return;
    setLocalItem(storageKey(userId), "1");
    void this.persistNative(userId, "1");
  }

  static clear(userId: string): void {
    if (!userId) return;
    removeLocalItem(storageKey(userId));
    void this.persistNative(userId, null);
  }

  /**
   * Restore the latch from durable native storage into localStorage so the
   * synchronous `isResolved` read is warm on a native cold start. Returns
   * whether the user is resolved after hydration. On web (or when nothing is
   * stored) it returns the current localStorage value without a native read.
   */
  static async hydrateFromNative(userId: string): Promise<boolean> {
    if (!userId) return false;
    if (this.isResolved(userId)) return true;
    if (!Capacitor.isNativePlatform()) return false;
    try {
      const { value } = await Preferences.get({ key: storageKey(userId) });
      if (value === "1") {
        setLocalItem(storageKey(userId), "1");
        return true;
      }
    } catch {
      // Best-effort: a failed native read simply falls back to the network
      // bootstrap admission path.
    }
    return false;
  }

  private static async persistNative(
    userId: string,
    value: "1" | null,
  ): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      if (value === null) {
        await Preferences.remove({ key: storageKey(userId) });
      } else {
        await Preferences.set({ key: storageKey(userId), value });
      }
    } catch {
      // Best-effort durable mirror; localStorage remains the source of truth
      // for web and for the in-session native path.
    }
  }
}
