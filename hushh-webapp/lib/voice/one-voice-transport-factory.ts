"use client";

import { GeminiLiveTransport } from "@/lib/services/gemini-live-client";
import type {
  OneVoiceProvider,
  OneVoiceTransportHandlers,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";

export const DEFAULT_ONE_VOICE_PROVIDER: OneVoiceProvider = "gemini_live";

/**
 * One realtime transport: the ADK live relay (Gemini Live over Vertex ADC).
 * The provider-neutral seam stays so a future transport can slot in behind
 * the same RealtimeVoiceTransport interface without touching callers.
 */
export function createRealtimeVoiceTransport(
  handlers: OneVoiceTransportHandlers = {},
  _provider: OneVoiceProvider = DEFAULT_ONE_VOICE_PROVIDER
): RealtimeVoiceTransport {
  return new GeminiLiveTransport(handlers);
}
