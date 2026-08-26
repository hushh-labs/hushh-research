import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import { ApiService } from "@/lib/services/api-service";

export type AgentChatMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  status: "complete" | "interrupted" | "error";
  content: string;
  model?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  metadata?: { kind?: string; display?: string } | null;
};

export type AgentChatConversation = {
  id: string;
  title: string;
  status: string;
  model?: string | null;
  message_count: number;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
};

export type AgentChatToolEvent = {
  callId: string;
  directiveId: string | null;
  conversationId: string | null;
  contextRevision: string | null;
  expiresAt: string | null;
  actionId: string | null;
  label: string;
  execution: "frontend" | "blocked" | string;
  slots: Record<string, unknown>;
  message: string;
  reason?: string | null;
  status?: string;
  requiresConfirmation: boolean;
  trustedActivationRequired: boolean;
  raw: Record<string, unknown>;
};

export type SpecialistDirectiveEvent = {
  delegateAgentId: string;
  directive: { kind: "action" | "prompt"; payload: Record<string, unknown> };
  message: string;
  stateChanged: boolean;
};

export type AgentSource = {
  agentId: string;
  label: string;
  reason: string;
};

export type AgentChatStreamHandlers = {
  onStart?: (payload: { conversationId: string; model?: string }) => void;
  onToolStart?: (payload: AgentChatToolEvent) => void;
  onToolWaiting?: (payload: AgentChatToolEvent) => void;
  onToolResult?: (payload: AgentChatToolEvent) => void;
  onToken?: (token: string) => void;
  onComplete?: (payload: { conversationId: string; model?: string }) => void;
  onError?: (message: string) => void;
  onSpecialistDirective?: (event: SpecialistDirectiveEvent) => void;
  onThought?: (text: string) => void;
  onSources?: (sources: AgentSource[]) => void;
};

// A fresh Agent runtime may need to resolve the vault-backed runtime contract
// and prepare the first persisted turn before FastAPI can open the SSE
// response. The Next proxy permits this route for two minutes; keep the
// browser-side guard finite, but do not reject a healthy cold start at 10s.
const SSE_OPEN_TIMEOUT_MS = 45_000;
const SSE_FIRST_MEANINGFUL_TIMEOUT_MS = 25_000;
const SSE_INACTIVITY_TIMEOUT_MS = 45_000;

async function openAgentChatStream(
  opener: (signal: AbortSignal) => Promise<Response>,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort("agent_chat_open_timeout");
        reject(new Error("Agent chat did not open in time. Please retry."));
      }, SSE_OPEN_TIMEOUT_MS);
    });
    return await Promise.race([opener(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseJsonPayload(data: string): Record<string, unknown> {
  const parsed = JSON.parse(data) as unknown;
  return asRecord(parsed) || {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key]) || {};
}

function formatAgentChatErrorMessage(message: string, code?: string): string {
  if (code === "AGENT_RUNTIME_CREDENTIAL_MISSING") {
    return "One needs your Gemini key. Add it in Connections settings, or switch to Hussh managed Gemini.";
  }
  if (code === "AGENT_RUNTIME_CREDENTIAL_INVALID") {
    return "Your saved Gemini key could not be used. Update it in Connections settings, or switch to Hussh managed Gemini.";
  }
  if (code === "AGENT_RUNTIME_MANAGED_CREDENTIALS_UNAVAILABLE") {
    return "Hussh managed Gemini is not available in this environment.";
  }
  if (code === "AGENT_RUNTIME_MODEL_UNAVAILABLE") {
    return "One's configured Gemini model is not available for this runtime.";
  }
  if (code === "AGENT_RUNTIME_EMPTY_RESPONSE") {
    return "One did not receive a response from the configured model. Please try again.";
  }
  return message || "Agent chat failed. Please try again.";
}

function resolveBrowserTimeZone(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolEvent(payload: Record<string, unknown>): AgentChatToolEvent {
  return {
    callId: readString(payload, "call_id"),
    directiveId: readString(payload, "directive_id") || null,
    conversationId: readString(payload, "conversation_id") || null,
    contextRevision: readString(payload, "context_revision") || null,
    expiresAt: readString(payload, "expires_at") || null,
    actionId: readString(payload, "action_id") || null,
    label: readString(payload, "label"),
    execution: readString(payload, "execution"),
    slots: readRecord(payload, "slots"),
    message: readString(payload, "message"),
    reason: readString(payload, "reason") || null,
    status: readString(payload, "status") || undefined,
    requiresConfirmation: payload.requires_confirmation === true,
    trustedActivationRequired: payload.trusted_activation_required === true,
    raw: payload,
  };
}

export async function confirmAgentChatAction(input: {
  directiveId: string;
  userId: string;
  conversationId: string;
  actionId: string;
  contextRevision: string;
  trustedActivation: true;
  vaultOwnerToken: string;
}): Promise<{ receipt: string; expiresAt: string }> {
  const response = await ApiService.confirmAgentChatAction(input);
  if (!response.ok) throw new Error(await readError(response));
  const payload = (await response.json()) as { receipt: string; expires_at: string };
  return { receipt: payload.receipt, expiresAt: payload.expires_at };
}

export async function consumeAgentChatAction(input: {
  directiveId: string;
  userId: string;
  conversationId: string;
  actionId: string;
  contextRevision: string;
  receipt: string;
  vaultOwnerToken: string;
}): Promise<void> {
  const response = await ApiService.consumeAgentChatAction(input);
  if (!response.ok) throw new Error(await readError(response));
}

export async function cancelAgentChatAction(input: {
  directiveId: string;
  userId: string;
  conversationId: string;
  actionId: string;
  contextRevision: string;
  reasonCode: string;
  vaultOwnerToken: string;
}): Promise<void> {
  const response = await ApiService.cancelAgentChatAction(input);
  if (!response.ok) throw new Error(await readError(response));
}

export async function settleAgentChatAction(input: {
  directiveId: string;
  userId: string;
  receipt: string;
  actionId: string;
  contextRevision: string;
  status: "succeeded" | "failed" | "cancelled";
  reasonCode: string;
  routeAfter?: string | null;
  screenAfter?: string | null;
  vaultOwnerToken: string;
}): Promise<void> {
  const response = await ApiService.settleAgentChatAction(input);
  if (!response.ok) throw new Error(await readError(response));
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as unknown;
  const record = asRecord(payload);
  const detailRecord = record ? asRecord(record.detail) : null;
  const code = detailRecord ? readString(detailRecord, "code") : record ? readString(record, "code") : "";
  const detail = detailRecord
    ? readString(detailRecord, "message")
    : record
      ? readString(record, "detail") || readString(record, "message")
      : "";
  return detail
    ? formatAgentChatErrorMessage(detail, code || undefined)
    : `Agent chat request failed (${response.status})`;
}

export async function streamAgentChat(input: {
  userId: string;
  message: string;
  conversationId?: string | null;
  vaultOwnerToken: string;
  pkmContext?: string;
  screenContext?: Record<string, unknown> | null;
  runtimeCredential?: string | null;
  runtimeCredentialMode?: string | null;
  runtimeCredentialTransport?: "developer_api" | "vertex_api_key" | null;
  runtimeVertexProject?: string | null;
  runtimeVertexLocation?: string | null;
  delegateAgentId?: string | null;
  delegateResult?: Record<string, unknown>;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  const timezone = resolveBrowserTimeZone();
  const response = await openAgentChatStream((signal) => ApiService.streamAgentChat({
    userId: input.userId,
    message: input.message,
    conversationId: input.conversationId || undefined,
    vaultOwnerToken: input.vaultOwnerToken,
    pkmContext: input.pkmContext,
    screenContext: input.screenContext,
    ...(timezone ? { timezone } : {}),
    runtimeCredential: input.runtimeCredential,
    runtimeCredentialMode: input.runtimeCredentialMode,
    runtimeCredentialTransport: input.runtimeCredentialTransport,
    runtimeVertexProject: input.runtimeVertexProject,
    runtimeVertexLocation: input.runtimeVertexLocation,
    delegateAgentId: input.delegateAgentId,
    delegateResult: input.delegateResult,
    signal,
  }), input.signal);

  return consumeAgentChatStream(response, input.handlers ?? {}, { signal: input.signal });
}

/**
 * Shared SSE consumer for the Agent chat event protocol (start / token /
 * tool_* / complete / error). Used by both the vault-gated full chat and the
 * pre-vault informational chat, which speak the exact same wire protocol.
 */
export async function consumeAgentChatStream(
  response: Response,
  handlers: AgentChatStreamHandlers,
  options?: {
    signal?: AbortSignal;
    inactivityTimeoutMs?: number;
    firstMeaningfulTimeoutMs?: number;
  }
): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Agent chat stream did not include a response body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let conversationId = response.headers.get("X-Agent-Conversation-Id");
  let model = response.headers.get("X-Agent-Model");
  let text = "";
  let streamError: string | null = null;

  const handleFrame = (event: string, data: string): boolean => {
    let payload: Record<string, unknown>;
    try {
      payload = parseJsonPayload(data);
    } catch {
      streamError = "Agent chat stream returned malformed information. Please retry.";
      handlers?.onError?.(streamError);
      return true;
    }
    if (event === "start") {
      conversationId = readString(payload, "conversation_id") || conversationId;
      model = readString(payload, "model") || model;
      handlers?.onStart?.({
        conversationId: conversationId || "",
        model: model || undefined,
      });
      // The backend only emits `start` after it has authenticated the request,
      // resolved the runtime, and prepared the conversation. It is therefore
      // meaningful liveness, even if model token generation starts later.
      return true;
    }
    if (event === "token") {
      const token = readString(payload, "token");
      if (token) {
        text += token;
        handlers?.onToken?.(token);
      }
      return Boolean(readString(payload, "token"));
    }
    if (event === "thought") {
      const thought = readString(payload, "text");
      if (thought) handlers?.onThought?.(thought);
      return true;
    }
    if (event === "tool_start") {
      handlers?.onToolStart?.(normalizeToolEvent(payload));
      return true;
    }
    if (event === "tool_waiting") {
      handlers?.onToolWaiting?.(normalizeToolEvent(payload));
      return true;
    }
    if (event === "tool_result") {
      handlers?.onToolResult?.(normalizeToolEvent(payload));
      return true;
    }
    if (event === "complete") {
      conversationId = readString(payload, "conversation_id") || conversationId;
      model = readString(payload, "model") || model;
      handlers?.onComplete?.({
        conversationId: conversationId || "",
        model: model || undefined,
      });
      return true;
    }
    if (event === "error") {
      streamError = formatAgentChatErrorMessage(
        readString(payload, "message"),
        readString(payload, "code") || undefined
      );
      handlers?.onError?.(streamError);
      return true;
    }
    if (event === "specialist_directive") {
      const p = payload as Record<string, unknown>;
      const directive = (p.directive ?? {}) as Record<string, unknown>;
      handlers?.onSpecialistDirective?.({
        delegateAgentId: String(p.delegate_agent_id ?? ""),
        directive: {
          kind: (directive.kind === "prompt" ? "prompt" : "action"),
          payload: (directive.payload ?? {}) as Record<string, unknown>,
        },
        message: String(p.message ?? ""),
        stateChanged: Boolean(p.state_changed),
      });
      return true;
    }
    if (event === "sources") {
      const raw = Array.isArray(payload.sources) ? payload.sources : [];
      const sources: AgentSource[] = raw
        .map((entry) => asRecord(entry))
        .filter((r): r is Record<string, unknown> => r !== null)
        .map((r) => ({
          agentId: readString(r, "agent_id"),
          label: readString(r, "label"),
          reason: readString(r, "reason"),
        }));
      handlers?.onSources?.(sources);
      return true;
    }
    return false;
  };

  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? SSE_INACTIVITY_TIMEOUT_MS;
  const firstMeaningfulTimeoutMs =
    options?.firstMeaningfulTimeoutMs ?? SSE_FIRST_MEANINGFUL_TIMEOUT_MS;
  const firstMeaningfulDeadline = Date.now() + firstMeaningfulTimeoutMs;
  let sawMeaningfulEvent = false;

  // Race each read against an inactivity deadline so a silently dead connection
  // rejects instead of hanging the UI indefinitely. The watchdog is reset on
  // every chunk by virtue of being re-armed for the next read.
  const readWithWatchdog = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      const waitMs = sawMeaningfulEvent
        ? inactivityTimeoutMs
        : Math.max(0, firstMeaningfulDeadline - Date.now());
      timer = setTimeout(() => {
        reject(
          new Error(
            sawMeaningfulEvent
              ? "Agent chat stream stalled. Please try again."
              : "One did not respond in time. Please retry.",
          ),
        );
      }, waitMs);
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  while (true) {
    if (options?.signal?.aborted) {
      await reader.cancel();
      throw new DOMException("Aborted", "AbortError");
    }

    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readWithWatchdog();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const { done, value } = result;
    if (done) break;
    const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), buffer);
    buffer = parsed.remainder;
    for (const frame of parsed.events) {
      sawMeaningfulEvent = handleFrame(frame.event, frame.data) || sawMeaningfulEvent;
    }
  }

  const flushed = decoder.decode();
  if (flushed) {
    const parsed = parseSSEBlocks(flushed, buffer);
    buffer = parsed.remainder;
    for (const frame of parsed.events) {
      sawMeaningfulEvent = handleFrame(frame.event, frame.data) || sawMeaningfulEvent;
    }
  }

  if (buffer.trim()) {
    const parsed = parseSSEBlocks("\n\n", buffer);
    for (const frame of parsed.events) {
      sawMeaningfulEvent = handleFrame(frame.event, frame.data) || sawMeaningfulEvent;
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }

  return { conversationId, model, text };
}

/**
 * Pre-vault informational/navigation-only agent turn.
 *
 * Calls the lower-privilege backend tier that never touches PKM/vault data and
 * is not persisted. Used by the single agent bar before the vault is unlocked,
 * including anonymous onboarding visitors.
 */
export async function streamAgentIntro(input: {
  message: string;
  screenContext?: Record<string, unknown> | null;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  const response = await openAgentChatStream((signal) => ApiService.streamAgentIntro({
    message: input.message,
    screenContext: input.screenContext,
    signal,
  }), input.signal);
  return consumeAgentChatStream(response, input.handlers ?? {}, { signal: input.signal });
}

export async function listAgentChatConversations(input: {
  userId: string;
  vaultOwnerToken: string;
  limit?: number;
}): Promise<AgentChatConversation[]> {
  const response = await ApiService.listAgentChatConversations(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = (await response.json()) as { conversations?: AgentChatConversation[] };
  return Array.isArray(payload.conversations) ? payload.conversations : [];
}

export async function getAgentChatHistory(input: {
  conversationId: string;
  vaultOwnerToken: string;
  limit?: number;
}): Promise<AgentChatMessage[]> {
  const response = await ApiService.getAgentChatHistory(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = (await response.json()) as { messages?: AgentChatMessage[] };
  return Array.isArray(payload.messages) ? payload.messages : [];
}

export async function renameAgentChatConversation(input: {
  conversationId: string;
  title: string;
  vaultOwnerToken: string;
}): Promise<AgentChatConversation> {
  const response = await ApiService.renameAgentChatConversation(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as AgentChatConversation;
}

export async function deleteAgentChatConversation(input: {
  conversationId: string;
  vaultOwnerToken: string;
}): Promise<{ conversation_id: string; deleted: boolean }> {
  const response = await ApiService.deleteAgentChatConversation(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as { conversation_id: string; deleted: boolean };
}

/**
 * Where a turn is answered: the shared hub, or the person's own pod.
 *
 * Returned alongside the answer so the UI can SAY which cell replied. The north star
 * requires the person to be able to tell whose compute served them; a silent switch
 * would make "your own private agent" an unverifiable claim.
 */
export type TurnCell = "hub" | "pod";

export type AgentTurnResult = {
  conversationId: string | null;
  model: string | null;
  text: string;
  cell: TurnCell;
  /** Present only for a pod turn: DERIVED by the pod, never asserted by the client. */
  grounded?: boolean;
};

/**
 * Run one Agent Chat turn on whichever cell belongs to this person.
 *
 * WHY THIS EXISTS RATHER THAN A BRANCH IN THE COMPONENT
 * `ApiService.runPodTurn` was complete and had ZERO callers, so every turn went to the
 * shared hub even for someone whose pod was live -- the north star's central claim
 * ("their complete agent ecosystem runs in their pod") was unreachable from the product.
 *
 * The two cells do not answer the same SHAPE. The hub streams SSE; the pod returns one
 * complete response. Branching inside the chat component would have put that difference
 * in a 4,600-line file at two separate call sites. It lives here instead, so the
 * component asks one question -- "run this turn" -- and the shape difference is owned in
 * one place.
 *
 * HONEST STREAMING, NOT FAKE STREAMING
 * A pod turn is delivered as ONE `onToken` call with the whole answer. It would have
 * been easy to slice the text and emit it character by character so the UI looked
 * identical, and that would be a lie about where the latency went: the person would see
 * a typing animation for text that had already fully arrived. The rail shows real
 * progress or it shows none.
 */
export async function runAgentChatTurn(input: {
  userId: string;
  message: string;
  conversationId?: string | null;
  vaultOwnerToken: string;
  pkmContext?: string;
  screenContext?: Record<string, unknown> | null;
  runtimeCredential?: string | null;
  runtimeCredentialMode?: string | null;
  runtimeCredentialTransport?: "developer_api" | "vertex_api_key" | null;
  runtimeVertexProject?: string | null;
  runtimeVertexLocation?: string | null;
  delegateAgentId?: string | null;
  delegateResult?: Record<string, unknown>;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
  /** The person's pod address, when they have one. Absent means "no pod": use the hub. */
  podHushhId?: string | null;
  /** Their pod's lifecycle state. Only `active` is answerable. */
  podState?: string | null;
}): Promise<AgentTurnResult> {
  const podIsAnswerable = Boolean(input.podHushhId) && input.podState === "active";
  if (!podIsAnswerable) {
    const streamed = await streamAgentChat(input);
    return { ...streamed, cell: "hub" };
  }

  const handlers = input.handlers ?? {};
  const conversationId = input.conversationId || "";
  try {
    const turn = await ApiService.runPodTurn({
      hushhId: String(input.podHushhId),
      message: input.message,
      conversationId: input.conversationId || undefined,
      timezone: resolveBrowserTimeZone(),
      runtimeCredential: input.runtimeCredential,
      runtimeCredentialTransport: input.runtimeCredentialTransport || undefined,
      vertexProject: input.runtimeVertexProject,
      vertexLocation: input.runtimeVertexLocation,
      // The owner's own consented projection, decrypted on their device. This is what
      // makes a pod turn grounded WITHOUT the pod holding PKM or reaching a database.
      pkmContext: input.pkmContext,
      signal: input.signal,
    });

    handlers.onStart?.({ conversationId, model: turn.model });
    if (turn.text) handlers.onToken?.(turn.text);
    handlers.onComplete?.({ conversationId, model: turn.model });
    return {
      conversationId: input.conversationId ?? null,
      model: turn.model,
      text: turn.text,
      cell: "pod",
      grounded: turn.grounded,
    };
  } catch (error) {
    // The three typed failures `runPodTurn` raises are about THIS person's pod, and
    // each has a different remedy. Falling back to the hub would answer them anyway and
    // hide the fault -- the person would believe their pod served a turn it never saw,
    // which is the "200 on an empty page" failure this codebase argues against
    // everywhere else. Surface it and let the caller decide.
    const message = error instanceof Error ? error.message : "AGENT_UNREACHABLE";
    handlers.onError?.(message);
    throw error;
  }
}
