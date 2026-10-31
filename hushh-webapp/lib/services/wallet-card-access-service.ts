import { ApiService } from "@/lib/services/api-service";
import type { CardShareContext } from "./wallet-card-share-service";
import type { WalletCardPublicProfile } from "./wallet-card-service";
import { readCardRequest } from "@/lib/wallet/card-request";
import { z } from "zod";

const pendingCardRequestsSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), createdAt: z.string(), expiresAt: z.string() }).strict()).max(100),
  hasMore: z.boolean(), nextCursor: z.string().uuid().nullable(),
}).strict();

export type WalletAccessContext = Omit<CardShareContext, "vaultKey"> & { canDispatch?: () => boolean };
export class CardRequestStateError extends Error {
  constructor(readonly code: string) { super("Card request is unavailable."); }
}

export type CardSharingActivity = { event: string; at: string; actor: "owner" | "recipient"; outcome: string };
export type CardSharingHistoryItem = CardAccessGrant & {
  cardId: string; cardType: "payment" | "profile"; displayLabel: string; last4: string | null;
  senderName: string; createdAt: string; durationMinutes: 5 | 10 | 15 | 60 | 120;
  trustedCircle: boolean | null; method: "trusted_circle" | "standard_connection" | "legacy_unspecified";
  verificationMethod: string; verifiedAt: string | null; revokedAt: string | null;
  lastAccessedAt: string | null; permittedFields: string[]; activity: CardSharingActivity[];
};
export type CardSharingHistory = { recipientCount?: number; items: CardSharingHistoryItem[]; hasMore: boolean; nextCursor: string | null; serverNow: string };
const listeners = new Map<string, Set<() => void>>();
function changed(userId: string) { listeners.get(userId)?.forEach(listener => listener()); }

export type CardAccessRecipient = { personRef: string; displayName: string; photoUrl: string | null; trusted: boolean };
export type CardAccessGrant = { id: string; recipientName: string; createdAt?: string; expiresAt: string; status: "active" | "expired" | "revoked" };
export type CardAccessState = { eligible: boolean; reason?: string; grants: CardAccessGrant[]; hasMore?: boolean; nextCursor?: string | null };
export type CardAccessView = {
  status: "active" | "verification_required" | "expired" | "revoked" | "unavailable";
  expiresAt: string; serverNow: string; senderName: string;
  encryptedCard?: string; senderUserId?: string;
  card?: { brand: string; last4: string; expiryMonth: number; expiryYear: number; issuingRegion: string };
  cardType?: "payment" | "profile";
  profileCard?: Partial<WalletCardPublicProfile> & {
    fullName?: string; locationLabel?: string; preferredContact?: string;
    avatarUrl?: string; updatedOn?: string;
  };
};
export class CardAccessUnavailableError extends Error {
  readonly readinessUnavailable: boolean;
  constructor(readonly code = "WALLET_CARD_ACCESS_UNAVAILABLE") {
    super("Card sharing is temporarily unavailable.");
    this.readinessUnavailable = ["WALLET_CARD_ACCESS_DISABLED", "WALLET_CARD_ACCESS_NOT_READY"].includes(code);
  }
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
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const code = error?.detail?.code;
    if (response.status === 503) {
      const reason = ["WALLET_CARD_ACCESS_DISABLED", "WALLET_CARD_ACCESS_NOT_READY"].includes(code) ? code : undefined;
      throw new CardAccessUnavailableError(reason);
    }
    if (["WALLET_CARD_REQUEST_PENDING", "WALLET_CARD_REQUEST_CLOSED", "WALLET_CARD_REQUEST_NOT_FOUND"].includes(code)) throw new CardRequestStateError(code);
    throw new Error("Card access is unavailable. Please try again.");
  }
  return response.json() as Promise<T>;
}
async function ownerRequest<T>(context: WalletAccessContext, path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  const token = await context.getIdToken();
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  const isEffectCurrent = method !== "GET" && context.canDispatch
    ? () => context.isCurrent() && context.canDispatch?.() !== false
    : context.isCurrent;
  const result = await request<T>(token, path, method, body, context.vaultOwnerToken, signal, isEffectCurrent);
  if (!context.isCurrent()) throw new Error("Wallet changed.");
  return result;
}
export const WalletCardAccessService = {
  listRequests: async (context: WalletAccessContext, cursor?: string) =>
    pendingCardRequestsSchema.parse(await ownerRequest(context, `/requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)),
  createRequest: async (context: WalletAccessContext, personRef: string, requestId: string) =>
    readCardRequest(await ownerRequest(context, "/requests", "POST", { personRef, requestId })),
  getRequest: async (context: WalletAccessContext, requestId: string, signal?: AbortSignal) =>
    readCardRequest(await ownerRequest(context, `/requests/${encodeURIComponent(requestId)}`, "GET", undefined, signal)),
  decideRequest: async (context: WalletAccessContext, requestId: string, action: "decline" | "cancel") =>
    readCardRequest(await ownerRequest(context, `/requests/${encodeURIComponent(requestId)}/${action}`, "POST")),
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
  share: async (context: CardShareContext, cardId: string, recipientPersonRefs: string[], durationMinutes: 5 | 10 | 15 | 60 | 120, requestId: string, encryptedCards?: Record<string, string>, cardRequestId?: string) => {
    const result = await ownerRequest<{ grants: CardAccessGrant[] }>(context, `/cards/${encodeURIComponent(cardId)}/grants`, "POST", { requestId, recipientPersonRefs, durationMinutes, ...(encryptedCards ? { encryptedCards } : {}), ...(cardRequestId ? { cardRequestId } : {}) });
    changed(context.userId); return result;
  },
  revoke: async (context: CardShareContext, grantId: string) => {
    const result = await ownerRequest<{ revoked: boolean }>(context, `/grants/${encodeURIComponent(grantId)}`, "DELETE");
    changed(context.userId); return result;
  },
  view: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}`),
  verify: (idToken: string, grantId: string) => request<CardAccessView>(idToken, `/grants/${encodeURIComponent(grantId)}/verify`, "POST"),
};
