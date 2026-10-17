import { apiJson } from "@/lib/services/api-client";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import {
  ownerContentIsPrivate,
  privateAgentSpecialistTurn,
} from "@/lib/services/private-agent-specialist-chat";

/** One conversational turn with the Gmail inbox agent. */
export interface EmailChatResponse {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
}

function jsonAuthHeaders(vaultOwnerToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${vaultOwnerToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Client for the Gmail inbox agent chat. Mirrors OneMarketplaceService.chat: a
 * read-only conversational turn over the connected mailbox (needs-reply + inbox
 * search). VAULT_OWNER token authorizes the turn; the backend reuses the existing
 * gmail.readonly connection. A person whose agent runs privately asks their own
 * agent instead; the question never reaches the hub.
 */
export class EmailChatService {
  static async chat(params: {
    vaultOwnerToken: string;
    /** Unlocked vault key; only its derived chat key is sent (history is sealed with it). */
    vaultKey: string | null | undefined;
    message: string;
    conversationId?: string | null;
  }): Promise<EmailChatResponse> {
    if (await ownerContentIsPrivate()) {
      return privateAgentSpecialistTurn({ focus: "email", ...params });
    }
    return apiJson<EmailChatResponse>("/api/one/email/chat", {
      method: "POST",
      headers: {
        ...jsonAuthHeaders(params.vaultOwnerToken),
        ...(await oneChatKeyHeaders(params.vaultKey)),
      },
      body: JSON.stringify({
        message: params.message,
        conversationId: params.conversationId ?? null,
      }),
    });
  }
}
