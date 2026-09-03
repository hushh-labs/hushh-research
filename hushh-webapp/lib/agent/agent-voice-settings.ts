"use client";

// One Live is the only interactive audio owner. Other surfaces may request a
// session, but only the persistent Agent Bar can acquire the microphone,
// create the Live transport, or render native-audio playback.
export const AGENT_CONVERSATION_REQUEST_EVENT =
  "hushh:agent-conversation-request";
export const AGENT_CONVERSATION_READY_EVENT = "hushh:agent-conversation-ready";
/**
 * An explicit STOP, not the toggle.
 *
 * `requestAgentConversation` asks the owner to toggle, which starts a session
 * when none is running and no-ops during the window where the mic lease is
 * held but the transport is not live yet. Neither is what a caller means when
 * it needs a live One session to end, so the broker carries its own verb. The
 * caller still owns no audio: this is the same window-event shape.
 */
export const AGENT_CONVERSATION_STOP_EVENT = "hushh:agent-conversation-stop";
export const AGENT_CONVERSATION_OUTCOME_EVENT =
  "hushh:agent-conversation-outcome";

export type AgentConversationRequestSource = "agent_chat" | "siri_app_shortcut";

export type AgentConversationRequest = {
  source?: AgentConversationRequestSource;
  requestId?: string;
};

export type AgentConversationOutcome = {
  source: AgentConversationRequestSource;
  requestId: string;
  outcome: "accepted" | "failed";
};

export type AgentConversationDispatchResult =
  "dispatched" | "queued" | "duplicate";

let ownerReady = false;
let queuedRequest: AgentConversationRequest | null = null;
const knownRequestIds = new Set<string>();

function normalizedRequest(
  request: AgentConversationRequest = {},
): AgentConversationRequest {
  return {
    source: request.source ?? "agent_chat",
    requestId: request.requestId?.trim() || undefined,
  };
}

function dispatchRequest(request: AgentConversationRequest): void {
  window.dispatchEvent(
    new CustomEvent<AgentConversationRequest>(
      AGENT_CONVERSATION_REQUEST_EVENT,
      { detail: request },
    ),
  );
}

/**
 * Ask the persistent Agent Bar to start One Live. Existing no-argument callers
 * remain compatible. A request received before the sole owner mounts is held
 * as one metadata-only slot; duplicate ids are coalesced.
 */
export function requestAgentConversation(
  request: AgentConversationRequest = {},
): AgentConversationDispatchResult {
  if (typeof window === "undefined") return "queued";
  const normalized = normalizedRequest(request);
  if (normalized.requestId && knownRequestIds.has(normalized.requestId)) {
    return "duplicate";
  }
  if (normalized.requestId) knownRequestIds.add(normalized.requestId);

  if (!ownerReady) {
    queuedRequest = normalized;
    return "queued";
  }
  dispatchRequest(normalized);
  return "dispatched";
}

/**
 * Ask the persistent Agent Bar to END One Live now.
 *
 * Unqueued and unconditional on purpose. It is a no-op when nothing is
 * running, and being unconditional is the only shape that also covers the
 * window between the microphone lease being acquired and the transport coming
 * alive, where the shared voice store still reads "idle".
 */
export function requestAgentConversationStop(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AGENT_CONVERSATION_STOP_EVENT));
}

export function markAgentConversationOwnerReady(): () => void {
  if (typeof window === "undefined") return () => undefined;
  ownerReady = true;
  window.dispatchEvent(new Event(AGENT_CONVERSATION_READY_EVENT));
  if (queuedRequest) {
    const pending = queuedRequest;
    queuedRequest = null;
    queueMicrotask(() => {
      if (ownerReady) dispatchRequest(pending);
      else queuedRequest = pending;
    });
  }
  return () => {
    ownerReady = false;
  };
}

export function isAgentConversationOwnerReady(): boolean {
  return ownerReady;
}

export function acknowledgeAgentConversation(
  outcome: AgentConversationOutcome,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AgentConversationOutcome>(
      AGENT_CONVERSATION_OUTCOME_EVENT,
      { detail: outcome },
    ),
  );
}

/** Test-only reset for the module-scoped metadata broker. */
export function resetAgentConversationBrokerForTests(): void {
  ownerReady = false;
  queuedRequest = null;
  knownRequestIds.clear();
}

const DISABLED_FLAG_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

export function isAgentGeminiVoiceEnabled(): boolean {
  const configured = process.env.NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED;
  if (
    configured === undefined ||
    configured === null ||
    String(configured).trim() === ""
  ) {
    return true;
  }
  return !DISABLED_FLAG_VALUES.has(String(configured).trim().toLowerCase());
}
