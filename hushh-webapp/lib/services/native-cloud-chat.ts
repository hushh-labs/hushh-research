import { readNativeAdkTurn } from "@/lib/a2ui/native-adk-visual-stream";
import { sendWhileAgentWakes } from "@/lib/agent/owner-pod-wake";
import { parsePortfolioContextRequest, readPortfolioContext } from "@/lib/kai/portfolio-chat-context";
import { ApiService } from "./api-service";
import { createAgentStreamLiveness } from "./agent-chat-liveness";
import type { AgentChatStreamHandlers } from "./agent-chat-client";

export const NATIVE_CLOUD_CHAT_TRANSPORT = "native-adk-v1" as const;
export const DEV_FINANCE_VISUAL_MODE = "finance-dev" as const;

/** Contact the owner's pod directly. A caller decides compatibility before sending a turn. */
export async function admitsNativeCloudChat(
  headers: HeadersInit, isCurrent: () => boolean, signal?: AbortSignal,
  locationChatReview = false,
  locationChatConversation = false,
  visualMode?: typeof DEV_FINANCE_VISUAL_MODE,
): Promise<boolean> {
  const response = await ApiService.ownerPodRequest("agent-chat/capabilities", {
    headers, signal, cache: "no-store",
  }, false, undefined, undefined, isCurrent);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  const payload = await response.json().catch(() => null) as {
    nativeAdkChatVersion?: unknown; nativeFinanceVisualVersion?: unknown;
    nativeLocationChatReview?: unknown; nativeLocationChatConversation?: unknown;
  } | null;
  const version = visualMode === DEV_FINANCE_VISUAL_MODE
    ? payload?.nativeFinanceVisualVersion : payload?.nativeAdkChatVersion;
  return isCurrent() && version === (visualMode === DEV_FINANCE_VISUAL_MODE ? 2 : 1) &&
    (!locationChatReview || payload?.nativeLocationChatReview === true) &&
    (!locationChatConversation || payload?.nativeLocationChatConversation === true);
}

export async function streamNativeCloudChat(input: {
  request: RequestInit;
  conversationId: string;
  isCurrent: () => boolean;
  handlers: AgentChatStreamHandlers;
  locationChatReview?: boolean;
  portfolio?: { userId: string; vaultKey: string; vaultOwnerToken: string; runId: string };
}) {
  const { request, conversationId, isCurrent, handlers } = input;
  const watchdog = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, watchdog.signal]) : watchdog.signal;
  const active = () => isCurrent() && !signal.aborted;
  let admittedPod: string | undefined;
  const liveness = createAgentStreamLiveness(
    () => sendWhileAgentWakes(
      () => ApiService.ownerPodRequest("agent-chat", { ...request, signal }, true,
        hushhId => { admittedPod = hushhId; }, undefined, active),
      { signal, isOwnerAgent: async () => active(), onWaking: () => handlers.onStreamHealth?.({ kind: "waking" }) },
    ),
    () => watchdog.abort(),
    () => handlers.onStreamHealth?.({ kind: "bytes" }),
    () => undefined,
  );
  let started = false;
  let lastMessageId: string | undefined;
  let lastLocationProposalId: string | undefined;
  let sentPortfolioResult = false;
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
      const { portfolioContext, ...visible } = output;
      if (portfolioContext && input.portfolio && !sentPortfolioResult) {
        sentPortfolioResult = true;
        handlers.onReceiptPrivate?.("portfolio");
        const { userId, vaultKey, vaultOwnerToken, runId } = input.portfolio;
        const query = parsePortfolioContextRequest(portfolioContext.request);
        if (query?.detail === "expanded") {
          void readPortfolioContext(
            { userId, vaultKey, vaultOwnerToken, threadId: conversationId },
            query,
            active,
            { allocationValues: portfolioContext.allocationValues === true },
          )
            .catch(() => ({ status: "unavailable", reason: "source_unavailable" }))
            .then(async result => {
              if (!active() || !admittedPod) return;
              const reply = await ApiService.ownerPodRequest("agent-chat/portfolio-context", {
                method: "POST", headers: request.headers, signal, cache: "no-store",
                body: JSON.stringify({ threadId: conversationId, runId,
                  requestId: portfolioContext.requestId, result }),
              }, false, undefined, admittedPod, active);
              await reply.body?.cancel().catch(() => undefined);
            }).catch(() => undefined); // The admitted tool has a bounded timeout.
        }
      }
      handlers.onStreamHealth?.({ kind: "activity" });
      if (output.serverMessageId && output.serverMessageId !== lastMessageId) {
        lastMessageId = output.serverMessageId;
        handlers.onServerMessageId?.(lastMessageId);
      }
      if (output.locationChatProposal && output.locationChatProposal.id !== lastLocationProposalId) {
        lastLocationProposalId = output.locationChatProposal.id;
        handlers.onLocationProposal?.(output.locationChatProposal);
      }
      handlers.onNativeOutput?.(visible);
    }, input.locationChatReview);
    if (!active()) throw new DOMException("Agent turn cancelled", "AbortError");
    return result;
  } catch (error) {
    if (watchdog.signal.aborted) throw new Error("AGENT_STREAM_INCOMPLETE");
    throw error;
  } finally {
    liveness.stop();
  }
}
