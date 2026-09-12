import { Capacitor } from "@capacitor/core";

import { BrowserSpeechAdapter } from "./browser-speech-adapter";
import { BrowserLocalSpeechAdapter } from "./browser-local-speech-adapter";
import { NativeSpeechAdapter } from "./native-speech-adapter";
import { getVoiceV2Flags } from "./voice-feature-flags";
import type {
  OneVoiceSpeechAdapter,
  SpeechAdapterCallbacks,
} from "./transcript-events";

/**
 * Selects an input adapter only. The resolver, action gateway, and session
 * owner are shared after this boundary on every platform.
 */
export function createOneVoiceSpeechAdapter(
  callbacks: SpeechAdapterCallbacks,
): OneVoiceSpeechAdapter {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
    return new NativeSpeechAdapter(callbacks);
  }
  if (getVoiceV2Flags().localRuntimeMode !== "off") {
    return new BrowserLocalSpeechAdapter(callbacks);
  }
  return new BrowserSpeechAdapter(callbacks);
}
