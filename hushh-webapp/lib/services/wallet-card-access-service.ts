import { ApiService } from "@/lib/services/api-service";
import type { CardShareContext } from "./wallet-card-share-service";
import type { WalletCardPublicProfile } from "./wallet-card-service";

export type CardSharingActivity = { event: string; at: string; actor: "owner" | "recipient"; outcome: string };
export type CardSharingHistoryItem = CardAccessGrant & {
  cardId: string; cardType: "payment" | "profile"; displayLabel: string; last4: string | null;
  senderName: string; createdAt: string; durationMinutes: 5 | 10 | 15;
  trustedCircle: boolean | null; method: "trusted_circle" | "standard_connection" | "legacy_unspecified";
  verificationMethod: string; verifiedAt: string | null; revokedAt: string | null;
  lastAccessedAt: string | null; permittedFields: string[]; activity: CardSharingActivity[];
};
export type CardSharingHistory = { items: CardSharingHistoryItem[]; hasMore: boolean; nextCursor: string | null; serverNow: string };
const listeners = new Map<string, Set<() => void>>();
function changed(userId: string) { listeners.get(userId)?.forEach(listener => listener()); }

export type CardAccessRecipient = { personRef: string; displayName: string; photoUrl: string | null; trusted: boolean };
export type CardAccessGrant = { id: string; recipientName: string; createdAt?: string; expiresAt: string; status: "active" | "expired" | "revoked" };
export type CardAccessState = { eligible: boolean; reason?: string; grants: CardAccessGrant[]; hasMore?: boolean; nextCursor?: string | null };
export type CardAccessView = {
  status: "active" | "verification_required" | "expired" | "revoked" | "unavailable";
  expiresAt: string; serverNow: string; senderName: string;
  card?: { brand: string; last4: string; expiryMonth: number; expiryYear: number; issuingRegion: string };
  cardType?: "payment" | "profile";
  profileCard?: Partial<WalletCardPublicProfile> & {
    fullName?: string; locationLabel?: string; preferredContact?: string;
    avatarUrl?: string; updatedOn?: string;
  };
};
export class CardAccessUnavailableError extends Error {
  constructor() { super("Card sharing is temporarily unavailable."); }
}
const root = "/api/one/wallet/card-access";
export const cardAccessReference = (content: string): string | null =>
  /^\[wallet-access:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]$/i.exec(content)?.[1] ?? null;

async function request<T>(idToken: string, path: string, method = "GET", body?: unknown, vaultOwnerToken?: string, signal?: AbortSignal, isEffectCurrent?: () => boolean): Promise<T> {
  const response = await ApiService.apiFetch(`${root}${path}`, {
    method, cache: "no-store", signal, isEffectCurrent,
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
  const result = await request<T>(token, path, method, body, context.vaultOwnerToken, signal, context.isCurrent);
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  return result;
}
export const WalletCardAccessService = {
  subscribe: (userId: string, listener: () => void) => {
    const set = listeners.get(userId) ?? new Set<() => void>();
    set.add(listener); listeners.set(userId, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(userId); };
  },
  history: (context: CardShareContext, options: { direction?: "outgoing" | "received"; cardType?: "payment" | "profile"; cursor?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams({ direction: options.direction ?? "outgoing" });
    if (options.cardType) query.set("cardType", options.cardType);
    if (options.cursor) query.set("cursor", options.cursor);
    return ownerRequest<CardSharingHistory>(context, `/history?${query}`, "GET", undefined, signal);
  },
  profile: (context: CardShareContext, signal?: AbortSignal) => ownerRequest<{ eligible: boolean; cardId: string | null }>(context, "/profile", "GET", undefined, signal),
  reserve: (idToken: string, vaultOwnerToken: string, requestId: string) => request<{ cardId: string | null; enabled: boolean }>(idToken, "/registrations", "POST", { requestId }, vaultOwnerToken),
  state: (context: CardShareContext, cardId: string, signal?: AbortSignal, cursor?: string) => ownerRequest<CardAccessState>(context, `/cards/${encodeURIComponent(cardId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, "GET", undefined, signal),
  recipients: (context: CardShareContext, query: string, signal?: AbortSignal) => ownerRequest<{ items: CardAccessRecipient[]; hasMore: boolean }>(context, `/connections?query=${encodeURIComponent(query)}`, "GET", undefined, signal),
  share: async (context: CardShareContext, cardId: string, recipientPersonRefs: string[], durationMinutes: 5 | 10 | 15, requestId: string) => {
    const result = await ownerRequest<{ grants: CardAccessGrant[] }>(context, `/cards/${encodeURIComponent(cardId)}/grants`, "POST", { requestId, recipientPersonRefs, durationMinutes });
    changed(context.userId); return result;
  },
  revoke: async (context: CardShareContext, grantId: string) => {
    const result = await ownerRequest<{ revoked: boolean }>(context, `/grants/${encodeURIComponent(grantId)}`, "DELETE");
    changed(context.userId); return result;
  },
  view: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}`),
  verify: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}/verify`, "POST"),
};
