"use client";

import type { OneVoiceProvider, OneVoiceTransportHandlers, RealtimeVoiceTransport } from "@/lib/voice/one-voice-transport";
export const DEFAULT_ONE_VOICE_PROVIDER: OneVoiceProvider = "gemini_live";
/** Explicit retirement response for source clients still using the old seam. */
export function createRealtimeVoiceTransport(_handlers: OneVoiceTransportHandlers = {}, _provider: OneVoiceProvider = DEFAULT_ONE_VOICE_PROVIDER): RealtimeVoiceTransport {
  throw new Error("ONE_LIVE_RETIRED: use Talk to One commands.");
}
