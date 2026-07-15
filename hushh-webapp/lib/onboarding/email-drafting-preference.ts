"use client";

import { Preferences } from "@capacitor/preferences";

/**
 * Local, device-scoped preference for whether One may draft email replies
 * from one@hushh.ai on the user's behalf.
 *
 * Fast-follow: move this to a real backend-persisted account preference so
 * it survives across devices instead of being local-storage-only.
 */
const STORAGE_KEY_PREFIX = "one_email_drafting_enabled_v1:";

export async function loadEmailDraftingEnabled(userId: string): Promise<boolean> {
  if (typeof window === "undefined" || !userId) return true;
  try {
    const result = await Preferences.get({ key: `${STORAGE_KEY_PREFIX}${userId}` });
    if (result.value === null) return true; // Default: enabled.
    return result.value === "true";
  } catch {
    return true;
  }
}

export async function saveEmailDraftingEnabled(
  userId: string,
  enabled: boolean,
): Promise<void> {
  if (typeof window === "undefined" || !userId) return;
  try {
    await Preferences.set({
      key: `${STORAGE_KEY_PREFIX}${userId}`,
      value: enabled ? "true" : "false",
    });
  } catch {
    /* storage unavailable — toggle degrades to session-default (enabled) */
  }
}
