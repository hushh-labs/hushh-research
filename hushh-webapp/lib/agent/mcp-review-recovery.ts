/** Fresh owner-keyed native reviews; no references enter the history cache. */
import { parseMcpCallReview } from "./mcp-call-review";
import { streamAgentChat, type AgentChatStreamHandlers } from "@/lib/services/agent-chat-client";
import { ApiService } from "@/lib/services/api-service";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { serverNow } from "./server-clock";

type ChatInput = Parameters<typeof streamAgentChat>[0];
type Review = Parameters<NonNullable<AgentChatStreamHandlers["onMcpReview"]>>[0];

export async function recoverMcpReviews(input: Pick<ChatInput,
  "userId" | "vaultOwnerToken" | "vaultKey" | "loadConnectorConfigurations"
> & { conversationId: string; isCurrent: () => boolean; handlers: AgentChatStreamHandlers }): Promise<Review[]> {
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = snapshotVaultSessionEpoch();
  const current = () => Boolean(owner?.userId === input.userId &&
    isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch) && input.isCurrent());
  if (!current()) return [];
  const response = await ApiService.getAgentChatHistory({ ...input, limit: 1 });
  if (!response.ok) throw new Error("Reconnect to restore the connector review.");
  const payload = await response.json() as { mcpReviews?: unknown };
  if (!current() || !Array.isArray(payload.mcpReviews) || payload.mcpReviews.length > 32) return [];
  const chatKey = Object.values(await oneChatKeyHeaders(input.vaultKey))[0] ?? "";
  if (!current()) return [];
  return payload.mcpReviews.flatMap((item): Review[] => {
    if (!item || typeof item !== "object" || typeof item.interruptId !== "string" ||
        !item.interruptId || item.interruptId.length > 256) return [];
    const reference = parseMcpCallReview({
      originalFunctionCall: { name: item.reference?.toolName, args: {} },
      toolConfirmation: { confirmed: false, payload: item.reference },
    });
    if (!reference || Date.parse(reference.expiresAt) <= serverNow()) return [];
    let attempted = false;
    return [{ reference, chatKey, conversationId: input.conversationId, isCurrent: current,
      loadConfiguration: input.loadConnectorConfigurations ? async () => {
        const configurations = await input.loadConnectorConfigurations!();
        if (!current()) throw new Error("The connector session changed.");
        const configuration = configurations.find(value => value.connectorId === reference.connectorId);
        if (reference.connectorId.startsWith("custom_") && !configuration) throw new Error("This connector was removed.");
        return configuration;
      } : undefined,
      resume: async (approval, signal, handlers) => {
        if (attempted || !current() || signal?.aborted) throw new Error("This review is no longer active.");
        attempted = true;
        await streamAgentChat({ ...input, message: "", signal, handlers: handlers ?? input.handlers,
          resumeMcpReview: { interruptId: item.interruptId, reference, approval },
        });
        if (!current()) throw new Error("The connector session changed.");
      },
    }];
  });
}
