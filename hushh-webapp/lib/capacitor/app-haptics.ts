"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { getNativeChromeCapabilities, nativeChrome } from "./native-chrome";
import { getNativeSessionPrivacyState, nativeDocumentId } from "./session-privacy";

export const usesNativeHapticPreference = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
const settings = registerPlugin<{
  getSettings(): Promise<{ hapticFeedback: boolean }>;
  updateSettings(options: { hapticFeedback: boolean }): Promise<{ success: boolean }>;
}>("HushhSettings");

export async function readAppHapticPreference(): Promise<boolean> {
  const result = await settings.getSettings();
  if (typeof result.hapticFeedback !== "boolean") throw new Error("HAPTIC_PREFERENCE_UNCONFIRMED");
  return result.hapticFeedback;
}
export async function writeAppHapticPreference(value: boolean): Promise<void> {
  if ((await settings.updateSettings({ hapticFeedback: value })).success !== true) throw new Error("HAPTIC_PREFERENCE_UNCONFIRMED");
}

/** Called only by an accepted authored interaction, never by route observation.
 * No retries, queued cues, protected fields or dependency on operation success. */
export function appHaptic(kind: "light" | "selection", intentId?: string) {
  if (!usesNativeHapticPreference() || document.visibilityState === "hidden") return;
  const documentId = nativeDocumentId(), issuedAtMs = Date.now();
  void (async () => {
    const acceptedIntentId = intentId ?? crypto.randomUUID();
    const capability = await getNativeChromeCapabilities();
    if (capability?.interactionFeedback !== true) return;
    const privacy = await getNativeSessionPrivacyState();
    if (privacy.shielded || !privacy.appIsActive || nativeDocumentId() !== documentId || Date.now() - issuedAtMs > 200) return;
    await nativeChrome.interactionFeedback({ documentId, privacyGeneration: privacy.generation, intentId: acceptedIntentId, kind, issuedAtMs });
  })().catch(() => { /* Feedback must not block or replay the user's action. */ });
}
