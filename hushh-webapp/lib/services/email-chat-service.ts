import { apiJson } from "@/lib/services/api-client";

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
 * gmail.readonly connection.
 */
export class EmailChatService {
  static async chat(params: {
    vaultOwnerToken: string;
    message: string;
    conversationId?: string | null;
  }): Promise<EmailChatResponse> {
    return apiJson<EmailChatResponse>("/api/one/email/chat", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        message: params.message,
        conversationId: params.conversationId ?? null,
      }),
    });
  }
}
