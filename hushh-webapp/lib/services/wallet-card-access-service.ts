import { ApiService } from "@/lib/services/api-service";
import type { CardShareContext } from "./wallet-card-share-service";

export type CardAccessRecipient = { personRef: string; displayName: string; photoUrl: string | null; trusted: boolean };
export type CardAccessGrant = { id: string; recipientName: string; createdAt?: string; expiresAt: string; status: "active" | "expired" | "revoked" };
export type CardAccessState = { eligible: boolean; reason?: string; grants: CardAccessGrant[]; hasMore?: boolean; nextCursor?: string | null };
export type CardAccessView = {
  status: "active" | "verification_required" | "expired" | "revoked";
  expiresAt: string; serverNow: string; senderName: string;
  encryptedCard?: string; senderUserId?: string;
  card?: { brand: string; last4: string; expiryMonth: number; expiryYear: number; issuingRegion: string };
};
export class CardAccessUnavailableError extends Error {
  constructor() { super("Card sharing is temporarily unavailable."); }
}
const root = "/api/one/wallet/card-access";
export const cardAccessReference = (content: string): string | null =>
  /^\[wallet-access:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]$/i.exec(content)?.[1] ?? null;

async function request<T>(idToken: string, path: string, method = "GET", body?: unknown, vaultOwnerToken?: string, signal?: AbortSignal): Promise<T> {
  const response = await ApiService.apiFetch(`${root}${path}`, {
    method, cache: "no-store", signal,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(vaultOwnerToken ? { "X-Hushh-Consent": vaultOwnerToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 503) throw new CardAccessUnavailableError();
  if (!response.ok) throw new Error("Card access is unavailable. Please try again.");
  return response.json() as Promise<T>;
}
async function ownerRequest<T>(context: CardShareContext, path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  const token = await context.getIdToken();
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  const result = await request<T>(token, path, method, body, context.vaultOwnerToken, signal);
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  return result;
}
export const WalletCardAccessService = {
  reserve: (idToken: string, vaultOwnerToken: string, requestId: string) => request<{ cardId: string | null; enabled: boolean }>(idToken, "/registrations", "POST", { requestId }, vaultOwnerToken),
  state: (context: CardShareContext, cardId: string, signal?: AbortSignal, cursor?: string) => ownerRequest<CardAccessState>(context, `/cards/${encodeURIComponent(cardId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, "GET", undefined, signal),
  recipients: (context: CardShareContext, query: string, signal?: AbortSignal) => ownerRequest<{ items: CardAccessRecipient[]; hasMore: boolean }>(context, `/connections?query=${encodeURIComponent(query)}`, "GET", undefined, signal),
  share: (context: CardShareContext, cardId: string, recipientPersonRefs: string[], durationMinutes: 5 | 10 | 15, requestId: string, encryptedCards?: Record<string, string>) =>
    ownerRequest<{ grants: CardAccessGrant[] }>(context, `/cards/${encodeURIComponent(cardId)}/grants`, "POST", { requestId, recipientPersonRefs, durationMinutes, ...(encryptedCards ? { encryptedCards } : {}) }),
  revoke: (context: CardShareContext, grantId: string) => ownerRequest<{ revoked: boolean }>(context, `/grants/${encodeURIComponent(grantId)}`, "DELETE"),
  view: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}`),
  verify: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}/verify`, "POST"),
};
