import { apiJson } from "@/lib/services/api-client";

/** A durable Information Marketplace access request (migration 075). */
export interface MarketplaceRequest {
  id: string;
  ownerUserId?: string;
  buyerUserId?: string | null;
  buyerLabel?: string | null;
  domain?: string;
  scopeHandle?: string | null;
  sliceName: string;
  priceCents?: number;
  currency?: string;
  durationDays?: number;
  message?: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt?: string;
  resolvedAt?: string | null;
}

/** One publishable slice suggested in a publish card. */
export interface PublishableSlice {
  label: string;
  domain: string;
  domainTitle?: string;
  scopeHandle?: string | null;
  suggestedPriceCents?: number;
  currency?: string;
}

/** Inline "publish for offers?" card the agent can surface in chat. */
export interface PublishSlicesAction {
  type: "publish_slices";
  topic?: string | null;
  slices: PublishableSlice[];
}

/** Response shape of POST /api/one/information/chat (see InformationChatService). */
export interface InformationChatResponse {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
  clientAction?: PublishSlicesAction;
}

function authHeaders(vaultOwnerToken: string): Record<string, string> {
  return { Authorization: `Bearer ${vaultOwnerToken}` };
}

function jsonAuthHeaders(vaultOwnerToken: string): Record<string, string> {
  return { ...authHeaders(vaultOwnerToken), "Content-Type": "application/json" };
}

/**
 * Client for the Information Marketplace: the conversational agent plus the
 * durable access-request inbox. Requests are real server-side records — approve/
 * deny happen server-side (from here, or via Agent One over A2A), and the chat's
 * `stateChanged` tells the page to refetch the inbox.
 */
export class OneMarketplaceService {
  static async chat(params: {
    vaultOwnerToken: string;
    message: string;
    conversationId?: string | null;
  }): Promise<InformationChatResponse> {
    return apiJson<InformationChatResponse>("/api/one/information/chat", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        message: params.message,
        conversationId: params.conversationId ?? null,
      }),
    });
  }

  static async listRequests(params: {
    vaultOwnerToken: string;
    status?: string;
  }): Promise<MarketplaceRequest[]> {
    const qs = params.status ? `?status=${encodeURIComponent(params.status)}` : "";
    const res = await apiJson<{ requests: MarketplaceRequest[] }>(
      `/api/one/marketplace/requests${qs}`,
      { headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
    return res.requests ?? [];
  }

  static async createRequest(params: {
    vaultOwnerToken: string;
    sliceName: string;
    domain: string;
    scopeHandle?: string | null;
    buyerLabel?: string;
    priceCents?: number;
    currency?: string;
    durationDays?: number;
    message?: string;
  }): Promise<MarketplaceRequest> {
    const res = await apiJson<{ request: MarketplaceRequest }>(
      "/api/one/marketplace/requests",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          sliceName: params.sliceName,
          domain: params.domain,
          scopeHandle: params.scopeHandle ?? null,
          buyerLabel: params.buyerLabel ?? null,
          priceCents: params.priceCents ?? 0,
          currency: params.currency ?? "USD",
          durationDays: params.durationDays ?? 30,
          message: params.message ?? null,
        }),
      },
    );
    return res.request;
  }

  static async approveRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/marketplace/requests/${encodeURIComponent(params.requestId)}/approve`,
      { method: "POST", headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
  }

  static async denyRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/marketplace/requests/${encodeURIComponent(params.requestId)}/deny`,
      { method: "POST", headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
  }
}
