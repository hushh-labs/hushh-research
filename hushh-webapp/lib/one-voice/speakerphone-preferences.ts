import { Capacitor } from "@capacitor/core";

/** Owner-local audio policy. iOS defaults safe; explicit choices remain authoritative. */
const SPEAKERPHONE_SAFE_KEY_PREFIX = "one_voice_preferences_v1:";
const SPEAKERPHONE_SAFE_KEY_SUFFIX = ":speakerphone_safe";

const speakerphoneRuntimeByUser = new Map<string, boolean>();
const speakerphoneListenersByUser = new Map<
  string,
  Set<(value: boolean) => void>
>();

export function speakerphoneSafePreferenceKey(userId: string): string {
  return `${SPEAKERPHONE_SAFE_KEY_PREFIX}${userId}${SPEAKERPHONE_SAFE_KEY_SUFFIX}`;
}

/** True when the person asked Live to stay half-duplex on this device. */
export function readSpeakerphoneSafePreference(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  const runtime = speakerphoneRuntimeByUser.get(userId);
  if (typeof runtime === "boolean") return runtime;
  const fallback = Capacitor.getPlatform() === "ios";
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(speakerphoneSafePreferenceKey(userId));
    return stored === "1" || (stored !== "0" && fallback);
  } catch {
    return fallback;
  }
}

export function writeSpeakerphoneSafePreference(
  userId: string | null | undefined,
  enabled: boolean,
): boolean {
  if (!userId) return false;
  speakerphoneRuntimeByUser.set(userId, enabled);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        speakerphoneSafePreferenceKey(userId),
        enabled ? "1" : "0",
      );
    } catch {
      // The in-memory value stays authoritative for this session.
    }
  }
  for (const listener of speakerphoneListenersByUser.get(userId) ?? []) {
    listener(enabled);
  }
  return enabled;
}

export function subscribeSpeakerphoneSafePreference(
  userId: string,
  listener: (enabled: boolean) => void,
): () => void {
  const listeners =
    speakerphoneListenersByUser.get(userId) ??
    new Set<(value: boolean) => void>();
  listeners.add(listener);
  speakerphoneListenersByUser.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) speakerphoneListenersByUser.delete(userId);
  };
}

/** Best-effort account-deletion cleanup for restricted browser storage. */
export function forgetSpeakerphoneSafePreference(
  userId: string | null | undefined,
): void {
  if (!userId) return;
  speakerphoneRuntimeByUser.delete(userId);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(speakerphoneSafePreferenceKey(userId));
    } catch {
      // Nothing further to do -- the runtime value is already cleared.
    }
  }
  for (const listener of speakerphoneListenersByUser.get(userId) ?? []) {
    listener(false);
  }
}

