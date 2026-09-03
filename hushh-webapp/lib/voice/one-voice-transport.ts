"use client";

import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type { OneVoiceUiState } from "@/lib/voice/voice-ui-state-machine";

export type OneVoiceProvider = "gemini_live";
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
      /**
       * Set only when the relay's own sessionEnded frame said so. A close
       * with no such frame (a raw network drop, a user hangup) carries no
       * opinion either way -- absence is not "not resumable", it is "unknown".
       */
      resumable?: boolean;
    }
  | {
      type: "closed";
      provider: OneVoiceProvider;
      /** Whatever resumption handle the provider last issued this session, if
       * any -- captured here since the client instance carrying it is torn
       * down immediately after, so a reconnect needs it handed off now. */
      resumptionHandle?: string | null;
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
      directive: {
        kind: string;
        payload?: Record<string, unknown>;
        /** Owning specialist from the relay envelope; never injected into model payload. */
        delegateAgentId?: string | null;
      };
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      /**
       * A read tool's display-safe result, forwarded alongside the spoken
       * answer so the app can render a card in sync with the readout
       * (#6434). Never executed, never settled -- unlike client_directive,
       * this is pure display data.
       */
      type: "tool_trace";
      provider: OneVoiceProvider;
      trace: {
        kind: string;
        payload?: Record<string, unknown>;
      };
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
  /**
   * Non-secret provider selection for this connection. The raw BYOK key, when
   * present, is sent exactly once in the first authenticated WebSocket frame
   * and is never kept in browser storage or route state.
   */
  runtimeCredentialMode?: "hushh_managed_vertex" | "byok" | null;
  runtimeCredential?: string | null;
  runtimeCredentialTransport?: "developer_api" | "vertex_api_key" | null;
  runtimeVertexProject?: string | null;
  runtimeVertexLocation?: string | null;
  /**
   * An opaque provider token from a previous socket for this same
   * conversation. Passing it lets a reconnect continue where the dropped
   * session left off instead of starting over; omitted, a fresh conversation
   * starts as it always did.
   */
  resumptionHandle?: string | null;
  /** A Gemini TTS prebuilt voice name from voice-persona-options.ts, or null/absent for the deployment default. */
  voiceName?: string | null;
  signal?: AbortSignal;
};

/** Browser-observed outcome for an action directive issued by One. */
export type OneVoiceActionSettlement = {
  directiveId: string;
  actionId: string;
  contextRevision: string;
  status: "succeeded" | "started" | "blocked" | "invalid" | "failed" | "noop";
  summary: string;
  reason?: string | null;
  routeAfter?: string | null;
  screenAfter?: string | null;
  /**
   * Present only when the relay has acknowledged the redacted destination
   * snapshot on this same socket before this settlement was sent.
   */
  destinationContextId?: string | null;
  /** Memory-only one-time receipt returned after the trusted confirmation tap. */
  receipt?: string | null;
};

export type OneVoiceActionConfirmation = {
  receipt: string;
  expiresAt: string;
};

export type OneVoiceContextApplyResult =
  | { status: "acknowledged"; contextId: string }
  | { status: "timeout" | "cancelled" | "closed"; contextId: string | null };

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
   * Publish one redacted snapshot and wait until the relay has persisted it.
   * Journey settlements use this barrier so destination actions never run on
   * an outgoing screen inventory.
   */
  applyContextAndWait?(
    context: OneVoiceContextSnapshot,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<OneVoiceContextApplyResult>;
  /**
   * Refresh the vault owner consent token inside an already-open session
   * (e.g. the user signs in or unlocks the vault mid-call). Without this,
   * a session started signed-out/locked stays permanently unable to reach
   * governed specialist tools even after the user authenticates, because
   * the token is otherwise only captured once at start(). Returns false
   * when no live session can accept the update.
   */
  updateConsentToken?(consentToken: string | null): boolean;
  confirmActionDirective?(input: {
    directiveId: string;
    actionId: string;
    contextRevision: string;
  }): Promise<OneVoiceActionConfirmation>;
  /**
   * Return the browser-observed result of a One-issued action. The relay
   * correlates this with the directive before it becomes model context.
   */
  reportActionSettlement?(settlement: OneVoiceActionSettlement): boolean;
  interrupt?(): void;
  stop(): void;
}
