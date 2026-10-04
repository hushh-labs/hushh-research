import { apiJson } from "@/lib/services/api-client";
import { Capacitor } from "@capacitor/core";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { RecipientPayloadKeyUnavailableError } from "@/lib/one-location/encryption";
import type { OneLocationMyRecipientKey } from "@/lib/one-location/types";
import { openChatContent, openChatImage, sealChatMessage, type ChatMemberKey, type ChatMessage, type SealedChatMessage } from "@/lib/circle-chat/crypto";

export type CircleChatState = { members: ChatMemberKey[]; rosterVersion: string; unreadCount: number; latestSequence: number; muted: boolean };
export type CircleChatReceipt = { id: string; recipientCount: number | null; readCount: number };
export type CircleChatPage = { items: ChatMessage[]; hasMore: boolean; receipts?: CircleChatReceipt[] };
type WireChatPage = CircleChatPage & { senders?: { userId: string; name: string; photoUrl: string | null }[] };
export type CircleChatSession = { circleId: string; userId: string; vaultOwnerToken: string; vaultKey: string };
const root = (session: CircleChatSession) => `/api/one/circles/${encodeURIComponent(session.circleId)}/chat`;
function options(session: CircleChatSession, signal?: AbortSignal): RequestInit {
  return { headers: { Authorization: `Bearer ${session.vaultOwnerToken}`, "Content-Type": "application/json" }, signal, cache: "no-store" };
}
// Encrypted historical backups only; a WeakMap does not extend a vault session.
const backups = new WeakMap<CircleChatSession, Map<string, Promise<OneLocationMyRecipientKey>>>();
async function recover<T>(session: CircleChatSession, message: ChatMessage, open: (recovery?: { vaultKey: string; remoteBackup: OneLocationMyRecipientKey }) => Promise<T>): Promise<T> {
  try { return await open(); }
  catch (err) {
    if (!(err instanceof RecipientPayloadKeyUnavailableError)) throw err;
    let keys = backups.get(session);
    if (!keys) { keys = new Map(); backups.set(session, keys); }
    const id = message.envelope.recipientKeyId;
    let backup = keys.get(id);
    if (!backup) {
      if (keys.size >= 8) keys.delete(keys.keys().next().value!);
      backup = apiJson<OneLocationMyRecipientKey>(`${root(session)}/keys/${encodeURIComponent(id)}`, options(session));
      keys.set(id, backup);
    }
    try { return await open({ vaultKey: session.vaultKey, remoteBackup: await backup }); }
    catch (error) { keys.delete(id); throw error; }
  }
}

/** Uses the existing Next proxy and Capacitor JSON transport; no plaintext requests. */
export const CircleChatService = {
  async initialize(session: CircleChatSession): Promise<void> {
    await bootstrapCurrentUserLocationRecipientKey({ userId: session.userId,
      vaultOwnerToken: session.vaultOwnerToken, vaultKey: session.vaultKey, strictRecovery: true });
  },
  state: (session: CircleChatSession, signal?: AbortSignal) => apiJson<CircleChatState>(root(session), options(session, signal)),
  wait: (session: CircleChatSession, after: number, signal?: AbortSignal) => apiJson<{ latestSequence: number; changed: boolean; readChanged?: boolean; receiptsChanged?: boolean; photoChanged?: boolean }>(
    // Native HTTP cannot cancel an underlying request. Keep it awaited through
    // a pause/resume instead of abandoning it and consuming another wait slot.
    `${root(session)}/wait?after=${after}`, options(session, Capacitor.isNativePlatform() ? undefined : signal)),
  messages: async (session: CircleChatSession, page: { before?: number; after?: number; receiptAfter?: number; receiptThrough?: number } = {}, signal?: AbortSignal): Promise<CircleChatPage> => {
    const query = new URLSearchParams();
    if (page.before !== undefined) query.set("before", String(page.before));
    if (page.after !== undefined) query.set("after", String(page.after));
    if (page.receiptAfter !== undefined) query.set("receiptAfter", String(page.receiptAfter));
    if (page.receiptThrough !== undefined) query.set("receiptThrough", String(page.receiptThrough));
    const response = await apiJson<WireChatPage>(`${root(session)}/messages?${query}`, options(session, signal));
    const senders = new Map(response.senders?.map((sender) => [sender.userId, sender]));
    return { ...response, items: response.items.map((message) => ({ ...message,
      ...(senders.has(message.senderUserId) ? { senderPhotoUrl: senders.get(message.senderUserId)!.photoUrl } : {}),
    })) };
  },
  async prepare(session: CircleChatSession, text: string, file: File | null): Promise<SealedChatMessage> {
    const state = await CircleChatService.state(session);
    return sealChatMessage({ ...session, text, file, members: state.members, rosterVersion: state.rosterVersion });
  },
  send: (session: CircleChatSession, payload: SealedChatMessage) => apiJson<ChatMessage>(`${root(session)}/messages`,
    { ...options(session), method: "POST", body: JSON.stringify(payload) }),
  open: (session: CircleChatSession, message: ChatMessage) => recover(session, message,
    (recovery) => openChatContent(session.circleId, session.userId, message, recovery)),
  async image(session: CircleChatSession, message: ChatMessage, type: string, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    // Capacitor cannot cancel its physical download. Keep the scheduler slot
    // until it settles, then discard bytes after a logical pause/access loss.
    const image = await apiJson<{ ciphertext: string; iv: string }>(`${root(session)}/messages/${encodeURIComponent(message.id)}/image`, options(session, Capacitor.isNativePlatform() ? undefined : signal));
    signal?.throwIfAborted();
    return recover(session, message, (recovery) => openChatImage(session.circleId, session.userId, message, image, type, recovery));
  },
  async read(session: CircleChatSession, sequence: number): Promise<void> {
    await apiJson(`${root(session)}/read`, { ...options(session), method: "POST", body: JSON.stringify({ sequence }) });
    CircleChatService.refreshFeedRead(session.userId);
  },
  refreshFeedRead(userId: string): void {
    CacheSyncService.onFeedExternalReadChanged(userId);
    dispatchFeedStateChanged("action");
  },
  mute: (session: CircleChatSession, muted: boolean) => apiJson<{ muted: boolean }>(`${root(session)}/preferences`,
    { ...options(session), method: "PUT", body: JSON.stringify({ muted }) }),
};
