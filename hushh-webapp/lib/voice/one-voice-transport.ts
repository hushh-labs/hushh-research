"use client";

import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type { OneVoiceUiState } from "@/lib/voice/voice-ui-state-machine";

export type OneVoiceProvider = "gemini_live" | "openai_realtime";

export type OneVoiceSessionEvent =
  | {
      type: "state";
      provider: OneVoiceProvider;
      state: OneVoiceUiState;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
      message?: string | null;
    }
  | {
      type: "input_level" | "output_level";
      provider: OneVoiceProvider;
      level: number;
    }
  | {
      type: "error";
      provider: OneVoiceProvider;
      message: string;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      type: "closed";
      provider: OneVoiceProvider;
    };

export type OneVoiceTransportHandlers = {
  onEvent?: (event: OneVoiceSessionEvent) => void;
};

export type OneVoiceTransportStartOptions = {
  voice?: string | null;
  context?: OneVoiceContextSnapshot | null;
  signal?: AbortSignal;
};

export interface RealtimeVoiceTransport {
  readonly provider: OneVoiceProvider;
  start(options?: OneVoiceTransportStartOptions): Promise<void>;
  stop(): void;
}

export type OneVoiceActionProposal = {
  action_id: string;
  speaker_persona?: "one" | "kai" | "nav" | "kyc" | null;
  delegate_agent_id?: "one" | "kai" | "nav" | "kyc" | null;
  needs_confirmation: boolean;
  confidence?: number | null;
};
