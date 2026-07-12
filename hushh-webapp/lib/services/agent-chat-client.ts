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
  actionId: string | null;
  label: string;
  execution: "frontend" | "blocked" | string;
  slots: Record<string, unknown>;
  message: string;
  reason?: string | null;
  status?: string;
  raw: Record<string, unknown>;
};

export type SpecialistDirectiveEvent = {
  delegateAgentId: string;
  directive: { kind: "action" | "prompt"; payload: Record<string, unknown> };
  message: string;
  stateChanged: boolean;
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
};

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
    return "Kai needs your Gemini key. Add it in Profile > Runtime keys, or switch Kai to Hushh managed Gemini.";
  }
  if (code === "AGENT_RUNTIME_CREDENTIAL_INVALID") {
    return "Your saved Gemini key could not be used. Update it in Profile > Runtime keys, or switch Kai to Hushh managed Gemini.";
  }
  if (code === "AGENT_RUNTIME_MANAGED_CREDENTIALS_UNAVAILABLE") {
    return "Hushh managed Gemini is not available in this environment.";
  }
  if (code === "AGENT_RUNTIME_MODEL_UNAVAILABLE") {
    return "Kai's configured Gemini model is not available for this runtime.";
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
    actionId: readString(payload, "action_id") || null,
    label: readString(payload, "label"),
    execution: readString(payload, "execution"),
    slots: readRecord(payload, "slots"),
    message: readString(payload, "message"),
    reason: readString(payload, "reason") || null,
    status: readString(payload, "status") || undefined,
    raw: payload,
  };
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
  delegateAgentId?: string | null;
  delegateResult?: Record<string, unknown>;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  const timezone = resolveBrowserTimeZone();
  const response = await ApiService.streamAgentChat({
    userId: input.userId,
    message: input.message,
    conversationId: input.conversationId || undefined,
    vaultOwnerToken: input.vaultOwnerToken,
    pkmContext: input.pkmContext,
    screenContext: input.screenContext,
    ...(timezone ? { timezone } : {}),
    runtimeCredential: input.runtimeCredential,
    runtimeCredentialMode: input.runtimeCredentialMode,
    delegateAgentId: input.delegateAgentId,
    delegateResult: input.delegateResult,
    signal: input.signal,
  });

  return consumeAgentChatStream(response, input.handlers ?? {}, { signal: input.signal });
}

/**
 * Maximum time to wait for any single chunk before treating the stream as
 * stalled. Generation can pause between tokens (tool calls, model latency), so
 * this is generous; it only guards against a silently dead connection that
 * would otherwise hang the UI forever.
 */
const SSE_INACTIVITY_TIMEOUT_MS = 60_000;

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

  const handleFrame = (event: string, data: string) => {
    let payload: Record<string, unknown>;
    try {
      payload = parseJsonPayload(data);
    } catch {
      streamError = "Agent chat stream returned malformed information. Please retry.";
      handlers?.onError?.(streamError);
      return;
    }
    if (event === "start") {
      conversationId = readString(payload, "conversation_id") || conversationId;
      model = readString(payload, "model") || model;
      handlers?.onStart?.({
        conversationId: conversationId || "",
        model: model || undefined,
      });
      return;
    }
    if (event === "token") {
      const token = readString(payload, "token");
      if (token) {
        text += token;
        handlers?.onToken?.(token);
      }
      return;
    }
    if (event === "tool_start") {
      handlers?.onToolStart?.(normalizeToolEvent(payload));
      return;
    }
    if (event === "tool_waiting") {
      handlers?.onToolWaiting?.(normalizeToolEvent(payload));
      return;
    }
    if (event === "tool_result") {
      handlers?.onToolResult?.(normalizeToolEvent(payload));
      return;
    }
    if (event === "complete") {
      conversationId = readString(payload, "conversation_id") || conversationId;
      model = readString(payload, "model") || model;
      handlers?.onComplete?.({
        conversationId: conversationId || "",
        model: model || undefined,
      });
      return;
    }
    if (event === "error") {
      streamError = formatAgentChatErrorMessage(
        readString(payload, "message"),
        readString(payload, "code") || undefined
      );
      handlers?.onError?.(streamError);
      return;
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
    }
  };

  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? SSE_INACTIVITY_TIMEOUT_MS;

  // Race each read against an inactivity deadline so a silently dead connection
  // rejects instead of hanging the UI indefinitely. The watchdog is reset on
  // every chunk by virtue of being re-armed for the next read.
  const readWithWatchdog = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Agent chat stream stalled. Please try again."));
      }, inactivityTimeoutMs);
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
      handleFrame(frame.event, frame.data);
    }
  }

  const flushed = decoder.decode();
  if (flushed) {
    const parsed = parseSSEBlocks(flushed, buffer);
    buffer = parsed.remainder;
    for (const frame of parsed.events) {
      handleFrame(frame.event, frame.data);
    }
  }

  if (buffer.trim()) {
    const parsed = parseSSEBlocks("\n\n", buffer);
    for (const frame of parsed.events) {
      handleFrame(frame.event, frame.data);
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
  const response = await ApiService.streamAgentIntro({
    message: input.message,
    screenContext: input.screenContext,
    signal: input.signal,
  });
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
