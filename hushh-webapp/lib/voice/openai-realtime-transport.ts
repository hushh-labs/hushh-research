"use client";

import type {
  OneVoiceTransportHandlers,
  OneVoiceTransportStartOptions,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";

const NOT_ENABLED_MESSAGE =
  "OpenAI Realtime is scaffolded behind RealtimeVoiceTransport but is not enabled yet.";

export class OpenAIRealtimeTransport implements RealtimeVoiceTransport {
  readonly provider = "openai_realtime" as const;

  constructor(private readonly handlers: OneVoiceTransportHandlers = {}) {}

  async start(_options?: OneVoiceTransportStartOptions): Promise<void> {
    this.handlers.onEvent?.({
      type: "error",
      provider: this.provider,
      message: NOT_ENABLED_MESSAGE,
    });
    throw new Error(NOT_ENABLED_MESSAGE);
  }

  stop(): void {
    this.handlers.onEvent?.({
      type: "closed",
      provider: this.provider,
    });
  }
}
