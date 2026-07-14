"use client";

/**
 * Local, device-scoped preference for whether One may draft email replies
 * from one@hushh.ai on the user's behalf. This is a lightweight client-side
 * toggle (no backend capability-enable field exists yet for this); the
 * underlying inbox-review workflow at /one/kyc still requires the user to
 * approve every individual draft regardless of this toggle; this only
 * controls whether the setup step surfaces the feature as active.
 *
 * Fast-follow: move this to a real backend-persisted account preference so
 * it survives across devices instead of being local-storage-only.
 */
const STORAGE_KEY_PREFIX = "one_email_drafting_enabled_v1:";

export function loadEmailDraftingEnabled(userId: string): boolean {
  if (typeof window === "undefined" || !userId) return true;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${userId}`);
    if (raw === null) return true; // Default: enabled.
    return raw === "true";
  } catch {
    return true;
  }
}

export function saveEmailDraftingEnabled(
  userId: string,
  enabled: boolean,
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${userId}`,
      enabled ? "true" : "false",
    );
  } catch {
    /* storage unavailable — toggle degrades to session-default (enabled) */
  }
}
