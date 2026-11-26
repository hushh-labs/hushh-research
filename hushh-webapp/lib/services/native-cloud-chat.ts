import { readNativeAdkTurn } from "@/lib/a2ui/native-adk-visual-stream";
import { sendWhileAgentWakes } from "@/lib/agent/owner-pod-wake";
import { ApiService } from "./api-service";
import { createAgentStreamLiveness } from "./agent-chat-liveness";
import type { AgentChatStreamHandlers } from "./agent-chat-client";

export const NATIVE_CLOUD_CHAT_TRANSPORT = "native-adk-v1" as const;

/** Contact the owner's pod directly. A caller decides compatibility before sending a turn. */
export async function admitsNativeCloudChat(
  headers: HeadersInit, isCurrent: () => boolean, signal?: AbortSignal,
): Promise<boolean> {
  const response = await ApiService.ownerPodRequest("agent-chat/capabilities", {
    headers, signal, cache: "no-store",
  }, false, undefined, undefined, isCurrent);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  const payload = await response.json().catch(() => null) as { nativeAdkChatVersion?: unknown } | null;
  return isCurrent() && payload?.nativeAdkChatVersion === 1;
}

export async function streamNativeCloudChat(input: {
  request: RequestInit;
  conversationId: string;
  isCurrent: () => boolean;
  handlers: AgentChatStreamHandlers;
}) {
  const { request, conversationId, isCurrent, handlers } = input;
  const watchdog = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, watchdog.signal]) : watchdog.signal;
  const active = () => isCurrent() && !signal.aborted;
  const liveness = createAgentStreamLiveness(
    () => sendWhileAgentWakes(
      () => ApiService.ownerPodRequest("agent-chat", { ...request, signal }, true, undefined, undefined, active),
      { signal, isOwnerAgent: async () => active(), onWaking: () => handlers.onStreamHealth?.({ kind: "waking" }) },
    ),
    () => watchdog.abort(),
    () => handlers.onStreamHealth?.({ kind: "bytes" }),
    () => undefined,
  );
  let started = false;
  let lastMessageId: string | undefined;
  liveness.start();
  try {
    const response = await liveness.fetch({ ...request, signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: { code?: unknown } } | null;
      const value = body?.detail?.code;
      const code = typeof value === "string" && /^[A-Z_]{1,64}$/.test(value) ? value : "AGENT_ERROR";
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    const result = await readNativeAdkTurn(response, output => {
      if (!active()) return;
      if (output.sessionId && output.sessionId !== conversationId) throw new Error("POD_CHAT_REQUEST_INVALID");
      if (!started && output.sessionId) {
        started = true;
        handlers.onStart?.({ conversationId });
      }
      if (!started && output.status !== "error") throw new Error("POD_CHAT_REQUEST_INVALID");
      handlers.onStreamHealth?.({ kind: "activity" });
      if (output.serverMessageId && output.serverMessageId !== lastMessageId) {
        lastMessageId = output.serverMessageId;
        handlers.onServerMessageId?.(lastMessageId);
      }
      handlers.onNativeOutput?.(output);
    });
    if (!active()) throw new DOMException("Agent turn cancelled", "AbortError");
    return result;
  } catch (error) {
    if (watchdog.signal.aborted) throw new Error("AGENT_STREAM_INCOMPLETE");
    throw error;
  } finally {
    liveness.stop();
  }
}
