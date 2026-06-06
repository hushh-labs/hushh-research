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

export type AgentChatStreamHandlers = {
  onStart?: (payload: { conversationId: string; model?: string }) => void;
  onToolStart?: (payload: AgentChatToolEvent) => void;
  onToolWaiting?: (payload: AgentChatToolEvent) => void;
  onToolResult?: (payload: AgentChatToolEvent) => void;
  onToken?: (token: string) => void;
  onComplete?: (payload: { conversationId: string; model?: string }) => void;
  onError?: (message: string) => void;
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
  runtimeCredential?: string | null;
  runtimeCredentialMode?: string | null;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  const response = await ApiService.streamAgentChat({
    userId: input.userId,
    message: input.message,
    conversationId: input.conversationId || undefined,
    vaultOwnerToken: input.vaultOwnerToken,
    pkmContext: input.pkmContext,
    runtimeCredential: input.runtimeCredential,
    runtimeCredentialMode: input.runtimeCredentialMode,
    signal: input.signal,
  });

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
    const payload = parseJsonPayload(data);
    if (event === "start") {
      conversationId = readString(payload, "conversation_id") || conversationId;
      model = readString(payload, "model") || model;
      if (conversationId) {
        input.handlers?.onStart?.({ conversationId, model: model || undefined });
      }
      return;
    }
    if (event === "token") {
      const token = readString(payload, "token");
      if (token) {
        text += token;
        input.handlers?.onToken?.(token);
      }
      return;
    }
    if (event === "tool_start") {
      input.handlers?.onToolStart?.(normalizeToolEvent(payload));
      return;
    }
    if (event === "tool_waiting") {
      input.handlers?.onToolWaiting?.(normalizeToolEvent(payload));
      return;
    }
    if (event === "tool_result") {
      input.handlers?.onToolResult?.(normalizeToolEvent(payload));
      return;
    }
    if (event === "complete") {
      conversationId = readString(payload, "conversation_id") || conversationId;
      model = readString(payload, "model") || model;
      input.handlers?.onComplete?.({
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
      input.handlers?.onError?.(streamError);
    }
  };

  while (true) {
    if (input.signal?.aborted) {
      await reader.cancel();
      throw new DOMException("Aborted", "AbortError");
    }

    const { done, value } = await reader.read();
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
