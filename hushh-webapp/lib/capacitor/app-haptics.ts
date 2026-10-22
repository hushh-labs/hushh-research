"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { getNativeChromeCapabilities, nativeChrome } from "./native-chrome";
import { getNativeSessionPrivacyState, nativeDocumentId, nativePrivacyObservation } from "./session-privacy";
import type { HushhSettingsPlugin } from "./index";

export const usesNativeHapticPreference = () => Capacitor.isNativePlatform() && ["ios", "android"].includes(Capacitor.getPlatform());
const settings = registerPlugin<HushhSettingsPlugin>("HushhSettings");
let feedbackTransport: Promise<"settings" | "chrome" | null> | undefined;
function transport() {
  return feedbackTransport ??= settings.getFeedbackCapabilities()
    .then(capability => capability.interactionFeedback === true ? "settings" as const : null)
    .catch(async () => Capacitor.getPlatform() === "ios" && (await getNativeChromeCapabilities())?.interactionFeedback === true ? "chrome" as const : null);
}

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
  const observation = nativePrivacyObservation();
  // An unobserved lifecycle cannot authorize a delayed vibration. Bootstrap
  // already observes privacy; feedback never performs validation itself.
  if (!observation.state || observation.state.shielded || !observation.state.appIsActive) return;
  const documentId = nativeDocumentId(), issuedAtMs = Date.now();
  void (async () => {
    const selectedTransport = await transport();
    if (!selectedTransport) return;
    const privacy = await getNativeSessionPrivacyState();
    if (privacy.shielded || !privacy.appIsActive || privacy.generation !== observation.state?.generation ||
        nativePrivacyObservation().epoch !== observation.epoch || document.visibilityState === "hidden" ||
        nativeDocumentId() !== documentId || Date.now() - issuedAtMs > 200) return;
    const request = { documentId, privacyGeneration: privacy.generation, intentId: intentId ?? crypto.randomUUID(), kind, issuedAtMs };
    if (selectedTransport === "settings") await settings.interactionFeedback(request);
    else await nativeChrome.interactionFeedback(request);
  })().catch(() => { /* Feedback must not block or replay the user's action. */ });
}
