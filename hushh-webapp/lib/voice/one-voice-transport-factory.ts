"use client";

import { GeminiLiveTransport } from "@/lib/services/gemini-live-client";
import { OpenAIRealtimeTransport } from "@/lib/voice/openai-realtime-transport";
import type {
  OneVoiceProvider,
  OneVoiceTransportHandlers,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";

export const DEFAULT_ONE_VOICE_PROVIDER: OneVoiceProvider = "gemini_live";

export function createRealtimeVoiceTransport(
  handlers: OneVoiceTransportHandlers = {},
  provider: OneVoiceProvider = DEFAULT_ONE_VOICE_PROVIDER
): RealtimeVoiceTransport {
  switch (provider) {
    case "openai_realtime":
      return new OpenAIRealtimeTransport(handlers);
    case "gemini_live":
    default:
      return new GeminiLiveTransport(handlers);
  }
}
