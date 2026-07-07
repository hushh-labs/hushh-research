"use client";

import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type { KaiActionDelegateAgentId, KaiActionSpeakerPersona } from "@/lib/voice/kai-action-gateway";
import type { OneVoiceUiState } from "@/lib/voice/voice-ui-state-machine";

export type OneVoiceProvider = "gemini_live" | "openai_realtime";
export type OneVoiceAccessTier =
  | "anon_onboarding"
  | "anon_browsing"
  | "signed_locked"
  | "signed_unlocked";

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
    }
  | {
      type: "transcript_final";
      provider: OneVoiceProvider;
      text: string;
      turnId?: string | null;
      confidence?: number | null;
      source?: "input" | "provider" | "app";
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      type: "assistant_text";
      provider: OneVoiceProvider;
      text: string;
      turnId?: string | null;
      source?: "model" | "composer" | "provider";
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      type: "action_proposal";
      provider: OneVoiceProvider;
      proposal: OneVoiceActionProposal;
      transcript?: string | null;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      type: "handoff";
      provider: OneVoiceProvider;
      target: "chat" | "consent" | "route";
      reason: string;
      payload?: Record<string, unknown>;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    };

export type OneVoiceTransportHandlers = {
  onEvent?: (event: OneVoiceSessionEvent) => void;
};

export type OneVoiceTransportStartOptions = {
  voice?: string | null;
  context?: OneVoiceContextSnapshot | null;
  accessTier?: OneVoiceAccessTier | null;
  relayUrl?: string | null;
  sessionMirrorId?: string | null;
  allowedActionIds?: string[] | null;
  signal?: AbortSignal;
};

export interface RealtimeVoiceTransport {
  readonly provider: OneVoiceProvider;
  start(options?: OneVoiceTransportStartOptions): Promise<void>;
  speakText?(input: {
    text: string;
    turnId?: string | null;
    segmentType?: "ack" | "final";
    signal?: AbortSignal;
  }): Promise<boolean>;
  interrupt?(): void;
  stop(): void;
}

export type OneVoiceActionProposal = {
  action_id: string;
  speaker_persona?: KaiActionSpeakerPersona | null;
  delegate_agent_id?: KaiActionDelegateAgentId | null;
  needs_confirmation: boolean;
  confidence?: number | null;
  slots?: Record<string, unknown>;
  reason?: string | null;
};
