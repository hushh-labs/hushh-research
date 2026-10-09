// Synthetic service port only. Render the production page, CSS and lifecycle.
import { dispatchDirectMessagesUpdated } from "../../lib/direct-messages/direct-message-events";
import { appInteractionCoordinator } from "../../lib/interaction/interaction-intent-coordinator";
import { changeOwner } from "./direct-chat-auth";
import type { DirectMessage, DirectMessageConversation } from "../../lib/services/direct-messages-service";
export const DIRECT_MESSAGE_MAX_LENGTH = 2000;
export class DirectMessagesServiceRequestError extends Error { status = 503; }
const rows = new Map<string, DirectMessage[]>();
for (const conversationId of ["maya", "arjun"]) rows.set(conversationId, Array.from({ length: 80 }, (_, index) => ({
  id: `${conversationId}-${index}`, conversationId, senderIsViewer: index % 3 === 1,
  content: index === 79 ? "Let’s meet tomorrow. I’ll share the details here 😊" : index === 78 ? "https://example.com/" + "long-path".repeat(50) : `Message ${index + 1} — a friendly conversation.`,
  createdAt: new Date(Date.UTC(2026, 9, 9, 9, index)).toISOString(), readAt: index % 3 === 1 ? "2026-10-09T12:00:00Z" : null,
})));
function conversation(id: string): DirectMessageConversation {
  return { id, peerPersonRef: id, peerDisplayName: id === "maya" ? "Maya Rao" : "Arjun Mehta with a very long display name",
    peerPhotoUrl: id === "maya" ? "/fixture-person-0.webp" : "/fixture-person-1.webp", createdAt: rows.get(id)![0]!.createdAt,
    lastMessageAt: rows.get(id)!.at(-1)!.createdAt, latestMessage: rows.get(id)!.at(-1)!, unreadCount: rows.get(id)!.filter((item) => !item.senderIsViewer && !item.readAt).length };
}
const sends: { recipientPersonRef: string; content: string; clientMessageId: string; replyToMessageId?: string }[] = [];
const reads: { conversationId: string; throughMessageId: string }[] = [];
let loseResponse = false;
let delaySend = false;
let settleSend: (() => void) | null = null;
let delayInbox = new URLSearchParams(window.location.search).has("delayInbox");
let settleInbox: (() => void) | null = null;
let delayHistory = false;
let settleHistory: (() => void) | null = null;
let pendingHistory = false;
let delayRead = false;
let settleRead: (() => void) | null = null;
const fixture = {
  sends, reads,
  holdHistory: () => { delayHistory = true; },
  historyPending: () => pendingHistory,
  releaseHistory: () => { delayHistory = false; settleHistory?.(); settleHistory = null; },
  remoteChange: (id: string, content: string | null) => {
    const items = rows.get("maya")!;
    const row = items.find((item) => item.id === id)!;
    if (content === null) rows.set("maya", items.filter((item) => item.id !== id));
    else Object.assign(row, { content, editedAt: new Date().toISOString() });
    dispatchDirectMessagesUpdated({ userId: "fixture-owner", conversationId: "maya", messageId: `direct-message-action:${id}:fixture`, source: "sse" });
  },
  loseNextResponse: () => { loseResponse = true; },
  holdSend: () => { delaySend = true; }, releaseSend: () => { delaySend = false; settleSend?.(); settleSend = null; },
  changeOwner: () => { delayInbox = true; changeOwner("second-owner"); }, releaseInbox: () => { delayInbox = false; settleInbox?.(); settleInbox = null; },
  holdRead: () => { delayRead = true; }, releaseRead: () => { delayRead = false; settleRead?.(); settleRead = null; },
  lifecycle: (state: "active" | "background") => appInteractionCoordinator.handleLifecycle(state),
  incoming: (id = "maya") => {
    const items = rows.get(id)!;
    const message = { id: `${id}-incoming-${items.length}`, conversationId: id, senderIsViewer: false, content: `New message ${items.length + 1}`,
      createdAt: new Date(Date.parse(items.at(-1)!.createdAt) + 60_000).toISOString(), readAt: null };
    items.push(message); dispatchDirectMessagesUpdated({ userId: "fixture-owner", conversationId: id, messageId: message.id, source: "sse" }); return message.id;
  },
};
(window as unknown as { directChatFixture: typeof fixture }).directChatFixture = fixture;
export class DirectMessagesService {
  static async routeSelection(input: { token?: string; conversationId?: string; personRef?: string }) {
    const kind = input.personRef ? "person" : "conversation";
    const ref = input.token?.replace(/^dm1\./, "") ?? input.conversationId ?? input.personRef ?? "maya";
    return { token: `dm1.${ref}`, kind, ref };
  }
  static async routeHref(input: { conversationId?: string; personRef?: string }) { return `/one/messages?token=dm1.${input.conversationId ?? input.personRef}`; }

  static async listConversations() {
    if (delayInbox) await new Promise<void>((resolve) => { settleInbox = resolve; });
    return { items: [conversation("maya"), conversation("arjun")], unreadCount: conversation("maya").unreadCount + conversation("arjun").unreadCount };
  }
  static async getConversationMessages(input: { conversationId: string; before?: string; limit?: number }) {
    const items = rows.get(input.conversationId)!;
    const filtered = input.before ? items.slice(0, items.findIndex((item) => item.id === input.before)) : items;
    const page = filtered.slice(-60);
    const result = { conversation: { ...conversation(input.conversationId), unreadCount: 0 }, items: page.map((item) => ({ ...item })), canSend: true, disconnectedNotice: null,
      nextBefore: filtered.length > 60 ? page[0]!.id : null };
    if (delayHistory) { pendingHistory = true; await new Promise<void>((resolve) => { settleHistory = resolve; }); pendingHistory = false; }
    return result;
  }
  static async getConversationWithPerson(input: { personRef: string }) { return { conversation: conversation(input.personRef), canSend: true }; }
  static async sendMessage(input: typeof sends[number]) {
    sends.push({ ...input });
    if (delaySend) await new Promise<void>((resolve) => { settleSend = resolve; });
    const items = rows.get(input.recipientPersonRef)!;
    let message = items.find((item) => item.id === input.clientMessageId);
    if (!message) { message = { id: input.clientMessageId, conversationId: input.recipientPersonRef, senderIsViewer: true, content: input.content,
      createdAt: new Date(Date.parse(items.at(-1)!.createdAt) + 60_000).toISOString(), readAt: null }; items.push(message); }
    if (input.replyToMessageId) {
      const reply = items.find((item) => item.id === input.replyToMessageId)!;
      message.replyTo = { id: reply.id, content: reply.content, senderIsViewer: reply.senderIsViewer, deletedForEveryoneAt: reply.deletedForEveryoneAt ?? null };
    }
    if (loseResponse) { loseResponse = false; throw new Error("Delivery is unconfirmed. Try again."); }
    return { message: { ...message }, conversation: conversation(input.recipientPersonRef) };
  }
  static async markConversationRead(input: typeof reads[number]) {
    reads.push({ ...input });
    if (delayRead) await new Promise<void>((resolve) => { settleRead = resolve; });
    const items = rows.get(input.conversationId)!;
    const through = items.findIndex((item) => item.id === input.throughMessageId);
    for (const item of items.slice(0, through + 1)) if (!item.senderIsViewer) item.readAt = new Date().toISOString();
    return { readCount: through, readAt: new Date().toISOString() };
  }
  static async editMessage(input: { conversationId: string; messageId: string; content: string }) {
    const message = rows.get(input.conversationId)!.find((item) => item.id === input.messageId)!;
    Object.assign(message, { content: input.content, editedAt: new Date().toISOString() }); return { ...message };
  }
  static async deleteMessage(input: { conversationId: string; messageId: string; scope: "me" | "everyone" }) {
    const items = rows.get(input.conversationId)!;
    const message = items.find((item) => item.id === input.messageId)!;
    if (input.scope === "me") { rows.set(input.conversationId, items.filter((item) => item.id !== message.id)); return { scope: input.scope, message: null }; }
    Object.assign(message, { content: "", deletedForEveryoneAt: new Date().toISOString() }); return { scope: input.scope, message: { ...message } };
  }
  static async reactToMessage(input: { conversationId: string; messageId: string; emoji: string }) {
    const message = rows.get(input.conversationId)!.find((item) => item.id === input.messageId)!;
    message.reactions = [{ emoji: input.emoji, count: 1, reactedByViewer: true }]; return { ...message };
  }
  static async openEvents() { return new Response(new ReadableStream({ start() {} }), { status: 200 }); }
}
