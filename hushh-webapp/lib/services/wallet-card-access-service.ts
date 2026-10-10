import { ApiService } from "@/lib/services/api-service";
import type { CardShareContext } from "./wallet-card-share-service";

export type CardAccessRecipient = { personRef: string; displayName: string; photoUrl: string | null; trusted: boolean };
export type CardAccessGrant = { id: string; recipientName: string; expiresAt: string; status: "active" | "expired" | "revoked" };
export type CardAccessState = { eligible: boolean; reason?: string; grants: CardAccessGrant[] };
export type CardAccessView = {
  status: "active" | "verification_required" | "expired" | "revoked";
  expiresAt: string; serverNow: string; senderName: string;
  card?: { brand: string; last4: string; expiryMonth: number; expiryYear: number; issuingRegion: string };
};
const root = "/api/one/wallet/card-access";
export const cardAccessReference = (content: string): string | null =>
  /^\[wallet-access:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]$/i.exec(content)?.[1] ?? null;

async function request<T>(idToken: string, path: string, method = "GET", body?: unknown, vaultOwnerToken?: string): Promise<T> {
  const response = await ApiService.apiFetch(`${root}${path}`, {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(vaultOwnerToken ? { "X-Hushh-Consent": vaultOwnerToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error("Card access is unavailable. Please try again.");
  return response.json() as Promise<T>;
}
async function ownerRequest<T>(context: CardShareContext, path: string, method = "GET", body?: unknown): Promise<T> {
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  const token = await context.getIdToken();
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  const result = await request<T>(token, path, method, body, context.vaultOwnerToken);
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  return result;
}
export const WalletCardAccessService = {
  reserve: (idToken: string, vaultOwnerToken: string, requestId: string) => request<{ cardId: string | null; enabled: boolean }>(idToken, "/registrations", "POST", { requestId }, vaultOwnerToken),
  state: (context: CardShareContext, cardId: string) => ownerRequest<CardAccessState>(context, `/cards/${encodeURIComponent(cardId)}`),
  recipients: (context: CardShareContext, query: string) => ownerRequest<{ items: CardAccessRecipient[]; hasMore: boolean }>(context, `/connections?query=${encodeURIComponent(query)}`),
  share: (context: CardShareContext, cardId: string, recipientPersonRefs: string[], durationMinutes: 5 | 10 | 15, requestId: string) =>
    ownerRequest<{ grants: CardAccessGrant[] }>(context, `/cards/${encodeURIComponent(cardId)}/grants`, "POST", { requestId, recipientPersonRefs, durationMinutes }),
  revoke: (context: CardShareContext, grantId: string) => ownerRequest<{ revoked: boolean }>(context, `/grants/${encodeURIComponent(grantId)}`, "DELETE"),
  view: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}`),
  verify: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}/verify`, "POST"),
};
