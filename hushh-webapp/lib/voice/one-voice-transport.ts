"use client";

import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
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
      type: "handoff";
      provider: OneVoiceProvider;
      target: "chat" | "consent" | "route";
      reason: string;
      payload?: Record<string, unknown>;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      type: "client_directive";
      provider: OneVoiceProvider;
      directive: { kind: string; payload?: Record<string, unknown> };
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
  /**
   * Vault owner consent token, sent post-connect inside the app_context
   * frame (never in the URL) so One's specialist tools can act on the
   * user's behalf. Tools fail closed without it.
   */
  consentToken?: string | null;
  signal?: AbortSignal;
};

/** Browser-observed outcome for an action directive issued by One. */
export type OneVoiceActionSettlement = {
  directiveId: string;
  actionId: string;
  status: "succeeded" | "started" | "blocked" | "invalid" | "failed" | "noop";
  summary: string;
  reason?: string | null;
  routeAfter?: string | null;
  screenAfter?: string | null;
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
  /**
   * Push a redacted app-state refresh (screen change, action availability)
   * into the active session so voice context stays continuous across
   * navigation. Returns false when no live session can accept the update.
   */
  updateContext?(context: OneVoiceContextSnapshot): boolean;
  /**
   * Refresh the vault owner consent token inside an already-open session
   * (e.g. the user signs in or unlocks the vault mid-call). Without this,
   * a session started signed-out/locked stays permanently unable to reach
   * governed specialist tools even after the user authenticates, because
   * the token is otherwise only captured once at start(). Returns false
   * when no live session can accept the update.
   */
  updateConsentToken?(consentToken: string | null): boolean;
  /**
   * Return the browser-observed result of a One-issued action. The relay
   * correlates this with the directive before it becomes model context.
   */
  reportActionSettlement?(settlement: OneVoiceActionSettlement): boolean;
  interrupt?(): void;
  stop(): void;
}
