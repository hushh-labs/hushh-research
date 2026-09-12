"use client";

import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type { OneVoiceRealtimeAudioInput } from "@/lib/voice/realtime-audio-input";
import type { OneVoiceUiState } from "@/lib/voice/voice-ui-state-machine";
import type { OneVoiceSpeechAdapter } from "@/lib/voice/transcript-events";
import type { LocationOnboardingRunResultV1 } from "@/lib/services/one-location-onboarding-run-client";
import type { LocationCircleNameDirectiveV1 } from "@/lib/services/location-circle-name-interaction-client";

export type OneVoiceProvider = "gemini_live";
export type OneVoiceAccessTier =
  | "anon_onboarding"
  | "anon_browsing"
  | "signed_locked"
  | "signed_unlocked";

/**
 * The activation boundary supplied to the server relay.  It can only record
 * meaningful activity (thereby suppressing a greeting); the server remains
 * the sole authority that may issue a greeting directive.
 */
export type OneVoiceActivationSource =
  | "foreground_warm"
  | "tap"
  | "siri_app_shortcut"
  | "action_button"
  | "recovery";

/**
 * A server-derived, graph-registered Location navigation. The route is
 * deliberately query-free; Agent Bar compares it to the compiled action
 * registry again before it requests a client-side transition.
 */
export type LocationCommandNavigationDirectiveV1 = {
  schemaVersion: "one.location_navigation_directive.v1";
  capabilityId: string;
  route: string;
  settlement: "route_settlement_required";
};

/**
 * Identifier-only proof of a server-verified Location mutation. Static client
 * copy owns all visible text; no server/model prose or private values ride
 * this display contract.
 */
export type LocationCommandStatusCardV1 = {
  schemaVersion: "one.location_command_status_card.v1";
  surfaceId: "render.data_card";
  cardId:
    | "one.location.command.circle_verified.v1"
    | "one.location.command.location_verified.v1";
  actionId: "location.create_circle" | "workflow.setup.location";
  settlement: "verified";
};

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
      transcriptProvider?: string | null;
      onDevice?: boolean;
    }
  | {
      type: "transcript_partial";
      provider: OneVoiceProvider;
      text: string;
      confidence?: number | null;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
      transcriptProvider?: string | null;
      onDevice?: boolean;
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
      /**
       * Fixed server control output for an eligible foreground session. It is
       * not a Gemini turn, user text, or executable client directive.
       */
      type: "greeting";
      provider: OneVoiceProvider;
      greeting: {
        kind: "fresh_session";
        text: string;
        followUpWindowMs: number;
      };
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      /**
       * Emitted only after the fixed greeting's output lane has either drained
       * or conclusively failed to start. Capture must wait for this boundary
       * so One never hears its own welcome through the microphone.
       */
      type: "greeting_playback_settled";
      provider: OneVoiceProvider;
      greeting: {
        kind: "fresh_session";
        text: string;
        followUpWindowMs: number;
      };
      played: boolean;
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
      /**
       * Present for a manual Location command. A directive without the
       * matching completed command turn must never reach an app executor.
       */
      turnId?: string | null;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      /**
       * A completed Location command deliberately rotates its untagged Live
       * provider session before a later command tap. This is a normal ready-for-next-
       * command boundary, never an error or conversational reply.
       */
      type: "location_command_session_rollover";
      provider: OneVoiceProvider;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      /**
       * The relay accepted the transcript-first command after its relay,
       * provider, and context barriers. This is control-plane state only;
       * it contains no transcript, slots, entity values, or action result.
       */
      type: "location_command_ready";
      provider: OneVoiceProvider;
      turnId: string;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      /**
       * Gemini Live, not the browser/native client, detected speech end for
       * this command. It is a transcript-free control boundary: the client
       * stops capture, then still waits for final transcript + turnComplete
       * before any result/card can be surfaced.
       */
      type: "location_command_endpointed";
      provider: OneVoiceProvider;
      turnId: string;
      sessionId?: string | null;
      sourceId?: string | null;
      sourceSeq?: number | null;
    }
  | {
      /**
       * The server-owned Location runtime's terminal routing outcome. Any
       * executable directive remains separately typed and is emitted only
       * after the matching command turn fence has opened.
       */
      type: "location_command_result";
      provider: OneVoiceProvider;
      turnId: string;
      outcome:
        | "execute_started"
        | "interaction_required"
        | "navigate"
        | "ask"
        | "blocked"
        | "failed";
      reasonCode?: string | null;
      /**
       * Already validated against the generated Location run/card contracts.
       * It is presentation-only; it never asks the client to execute a
       * backend action.
       */
      result?: LocationOnboardingRunResultV1 | null;
      /** A fixed, server-leased Circle-name form; never a generic chat ask. */
      circleNameDirective?: LocationCircleNameDirectiveV1 | null;
      /** A bounded route from the compiled Location capability registry. */
      navigation?: LocationCommandNavigationDirectiveV1 | null;
      /** A static approved display card after verified server settlement. */
      statusCard?: LocationCommandStatusCardV1 | null;
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
  /**
   * A relay URL that is being minted concurrently with a physical microphone
   * tap.  Command transports may begin *local* bounded PCM capture before
   * this resolves, but must not open a socket or send PCM until it does.
   *
   * This is deliberately URL-only: the caller retains any companion
   * lifecycle metadata and no credential or provider routing authority is
   * added to the client contract.
   */
  relayUrlPromise?: Promise<string> | null;
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
  /**
   * Whether the relay may issue its server-owned idle greeting for this
   * socket. This changes output only: it never represents user speech and
   * does not arm microphone capture. Absent keeps the existing greeting
   * behavior for ordinary, tap-started sessions.
   */
  initialGreetingEnabled?: boolean;
  /**
   * Trusted only as a suppressive activity signal. ``foreground_warm`` and
   * ``recovery`` never reset the server's five-minute greeting eligibility.
   */
  activationSource?: OneVoiceActivationSource;
  /**
   * Platform PCM ingress for the shared Live session. On iOS this is the
   * Capacitor bridge around AVAudioEngine; on web the transport owns the
   * getUserMedia/AudioWorklet implementation directly. Audio is always
   * PCM16 mono at 16 kHz by the time it reaches the transport.
   *
   * This deliberately replaces native transcription as the online voice
   * gate. A platform can still expose an offline speech adapter elsewhere,
   * but it must not decide whether Gemini receives a live utterance.
   */
  realtimeAudioInput?: OneVoiceRealtimeAudioInput | null;
  /**
   * Open and authenticate the Live socket now but keep microphone capture
   * closed until startAudioInput() is called. This is how foreground warm
   * sessions avoid adding a mic-permission or capture side effect before a
   * person taps the voice control.
   */
  deferAudioInput?: boolean;
  /**
   * Location's tap-to-command, transcript-first lane. In this mode the
   * transport never plays model output or forwards a directive before the
   * explicit command-turn fence has opened.
   */
  locationCommandMode?: boolean;
  /**
   * Legacy offline/fallback adapter. New realtime callers should pass
   * realtimeAudioInput instead. It remains supported during migration so a
   * platform without PCM capture fails safely rather than losing voice.
   */
  speechAdapter?: OneVoiceSpeechAdapter | null;
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

/**
 * The real interaction that supplied an action confirmation. Keeping this
 * typed across the browser, iOS bridge, and relay prevents a model transcript
 * from being represented as a physical approval.
 */
export type OneVoiceConfirmationMethod =
  | "tap"
  | "voice"
  | "journey_grant";

export type OneVoiceContextApplyResult =
  | {
      status: "acknowledged";
      contextId: string;
      executableActionIds: string[];
    }
  | { status: "timeout" | "cancelled" | "closed"; contextId: string | null };

export interface RealtimeVoiceTransport {
  readonly provider: OneVoiceProvider;
  start(options?: OneVoiceTransportStartOptions): Promise<void>;
  /** Begin a previously deferred microphone/PCM input stream. */
  startAudioInput?(): Promise<boolean>;
  /**
   * Stop only microphone/PCM capture while retaining the authenticated relay,
   * its redacted context, and the output playback session. A subsequent tap
   * may call startAudioInput() again without forcing a Live reconnect.
   */
  stopAudioInput?(): Promise<void>;
  /**
   * Resume this transport's owned output context while a physical control
   * still has user activation. This affects playback only; it never opens
   * microphone/PCM capture.
   */
  resumeOutputForUserGesture?(): void;
  /**
   * Fence a pending trusted fixed greeting before a person claims a warm
   * transport for microphone capture. This is output-only cleanup: it must
   * never create a user turn or start/stop PCM by itself.
   */
  cancelGreetingOutput?(): void;
  /** Whether the session currently owns an open microphone/PCM input stream. */
  isAudioInputActive?(): boolean;
  /**
   * Start an explicit manual Location command turn. This is distinct from
   * opening the microphone: a warm relay may exist without a command, and
   * every PCM frame in a command is correlated to this opaque turn id.
   */
  beginInputTurn?(input: { turnId: string }): boolean;
  /**
   * Close a manual Location command after its capture tail has drained. The
   * transport derives the final sequence from delivered PCM when omitted.
   * `cancelled` is used for loss of pointer ownership or lifecycle aborts;
   * it must not be treated as permission to execute a partial utterance.
   */
  endInputTurn?(input: {
    turnId: string;
    finalSequence?: number;
    cancelled?: boolean;
  }): boolean;
  /**
   * Queue or send one real user text turn. Native/Siri request handoffs use
   * this path so the request is interpreted by One after app context is
   * acknowledged, never as app-composed speech.
   */
  sendUserText?(text: string): boolean;
  /** Wait for the initial redacted app context to be accepted by the relay. */
  waitForContextReady?(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<boolean>;
  /** Submit a generated-catalog action proposal without asking Gemini to route it. */
  proposeLocalAction?(input: {
    actionId: string;
    slots?: Record<string, unknown>;
    contextRevision: string;
    needsConfirmation: boolean;
    trustedActivationRequired?: boolean;
    goalId?: string | null;
  }): Promise<boolean>;
  /** Server-filtered executable inventory from the latest context barrier. */
  getExecutableActionIds?(): readonly string[] | null;
  speakText?(input: {
    text: string;
    turnId?: string | null;
    segmentType?: "ack" | "final";
    /**
     * Narrow control marker for a server-issued fixed greeting. It is never
     * available to application action code or user text paths.
     */
    controlKind?: "fresh_session_greeting";
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
    /**
     * The actual interaction that authorized this confirmation. The relay
     * uses this to enforce hard-card policies; it is not inferred from model
     * text or a client-side action id.
     */
    confirmationMethod: OneVoiceConfirmationMethod;
  }): Promise<OneVoiceActionConfirmation>;
  /**
   * Return the browser-observed result of a One-issued action. The relay
   * correlates this with the directive before it becomes model context.
   */
  reportActionSettlement?(settlement: OneVoiceActionSettlement): boolean;
  interrupt?(): void;
  stop(): void;
}
