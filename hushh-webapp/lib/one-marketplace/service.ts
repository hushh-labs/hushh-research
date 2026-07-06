import { apiJson } from "@/lib/services/api-client";
import { type PkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";
import { type MarketplaceEncryptedEnvelope } from "@/lib/one-marketplace/encryption";

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
  /** Set once a sealed slice envelope has been delivered (migration 079). */
  latestEnvelopeId?: string | null;
}

/**
 * A buyer's published recipient "lock" (ECDH P-256 public key). The private half
 * never leaves the buyer's device; the seller fetches this at approve time to
 * seal a slice envelope for the buyer.
 */
export interface MarketplaceRecipient {
  userId: string;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  algorithm: string;
  createdAt?: string | null;
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

/**
 * One listing in the cross-user Buyer directory. The owner's raw user id is never
 * sent — only a stable opaque `ownerRef`, the owner's public display name
 * (`ownerName`, so a buyer sees who published the slice), and an opaque
 * `listingId` the server maps back to the real owner when a request is filed.
 */
export interface AvailableListing {
  listingId: string;
  ownerRef: string;
  /** Public display name of the seller (falls back to `ownerRef` if unavailable). */
  ownerName?: string;
  domain: string;
  domainTitle: string;
  label: string;
  topLevelScopePath: string;
  attributeCount: number;
  /** The owner's published safe-summary preview — same detail shown on the owner side. */
  preview: PkmSectionPreviewPresentation | null;
  suggestedPriceCents: number;
  currency: string;
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
  /**
   * Publish this device's marketplace recipient public key so sellers can seal
   * delivered slices for this buyer. Idempotent: the server upserts on
   * (user_id, key_id). Only the public JWK is ever sent.
   */
  static async registerRecipientKey(params: {
    vaultOwnerToken: string;
    keyId: string;
    publicKeyJwk: JsonWebKey;
    algorithm: string;
  }): Promise<MarketplaceRecipient> {
    const res = await apiJson<{ recipientKey: MarketplaceRecipient }>(
      "/api/one/marketplace/recipient-keys",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          keyId: params.keyId,
          publicKeyJwk: params.publicKeyJwk,
          algorithm: params.algorithm,
        }),
      },
    );
    return res.recipientKey;
  }

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
    /** `owner` (default) is the seller's inbox; `buyer` is the caller's own requests. */
    role?: "owner" | "buyer";
  }): Promise<MarketplaceRequest[]> {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.role) query.set("role", params.role);
    const qs = query.toString() ? `?${query.toString()}` : "";
    const res = await apiJson<{ requests: MarketplaceRequest[] }>(
      `/api/one/marketplace/requests${qs}`,
      { headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
    return res.requests ?? [];
  }

  /**
   * Owner-scoped: fetch the buyer's active recipient "lock" for one of the
   * owner's pending requests, so the seller can seal a slice envelope for them
   * at approve time. `recipientKey` is null when the buyer has not published one.
   */
  static async getRequestRecipientKey(params: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<{ request: MarketplaceRequest; recipientKey: MarketplaceRecipient | null }> {
    return apiJson<{ request: MarketplaceRequest; recipientKey: MarketplaceRecipient | null }>(
      `/api/one/marketplace/requests/${encodeURIComponent(params.requestId)}/recipient-key`,
      { headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
  }

  /**
   * Buyer-scoped: fetch the latest sealed envelope delivered for one of the
   * caller's own requests. Ciphertext only — decrypt on-device with the
   * IndexedDB private key. `envelope` is null when nothing has been delivered.
   */
  static async getDelivery(params: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<{ request: MarketplaceRequest; envelope: MarketplaceEncryptedEnvelope | null }> {
    return apiJson<{ request: MarketplaceRequest; envelope: MarketplaceEncryptedEnvelope | null }>(
      `/api/one/marketplace/requests/${encodeURIComponent(params.requestId)}/delivery`,
      { headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
  }

  /** Anonymized directory of other users' published slices (Buyer tab). */
  static async listAvailable(params: {
    vaultOwnerToken: string;
  }): Promise<AvailableListing[]> {
    const res = await apiJson<{ listings: AvailableListing[] }>(
      "/api/one/marketplace/available",
      { headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
    return res.listings ?? [];
  }

  /** File a real cross-account access request against a listing's true owner. */
  static async requestListing(params: {
    vaultOwnerToken: string;
    listingId: string;
  }): Promise<MarketplaceRequest> {
    const res = await apiJson<{ request: MarketplaceRequest }>(
      `/api/one/marketplace/available/${encodeURIComponent(params.listingId)}/request`,
      { method: "POST", headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
    return res.request;
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

  /**
   * Approve a request. When `envelope` is supplied the seller has already sealed
   * the slice against the buyer's recipient key on-device, so only ciphertext is
   * posted (blind relay) and the server stores it for buyer pickup.
   */
  static async approveRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
    envelope?: MarketplaceEncryptedEnvelope | null;
  }): Promise<void> {
    await apiJson(
      `/api/one/marketplace/requests/${encodeURIComponent(params.requestId)}/approve`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ envelope: params.envelope ?? null }),
      },
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
