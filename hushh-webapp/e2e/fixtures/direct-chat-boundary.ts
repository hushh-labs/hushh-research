// Synthetic service port only. Render the production page, CSS and lifecycle.
import { dispatchDirectMessagesUpdated } from "../../lib/direct-messages/direct-message-events";
import { appInteractionCoordinator } from "../../lib/interaction/interaction-intent-coordinator";
import { changeOwner } from "./direct-chat-auth";
import type { DirectMessage, DirectMessageConversation } from "../../lib/services/direct-messages-service";
export const DIRECT_MESSAGE_MAX_LENGTH = 2000;
export class DirectMessagesServiceRequestError extends Error { status = 503; }
const rows = new Map<string, DirectMessage[]>();
const overflowingInbox = new URLSearchParams(location.search).has("overflowInbox");
const attachments = new Map<string, Blob>();
const pendingPhotos = new Map<string, { wait: Promise<void>; release: () => void; started: boolean }>();
const deliveries: { conversationId: string; messageIds: string[] }[] = [];
let delayOlder = false;
let settleOlder: (() => void) | null = null;
let olderPending = false;
let delayReaction = false;
let settleReaction: (() => void) | null = null;
for (const conversationId of ["maya", "arjun"]) rows.set(conversationId, Array.from({ length: 80 }, (_, index) => ({
  id: `${conversationId}-${index}`, conversationId, senderIsViewer: index % 3 === 1,
  content: index === 79 ? "Let’s meet tomorrow. I’ll share the details here 😊" : index === 78 ? "https://example.com/" + "long-path".repeat(50) : `Message ${index + 1} — a friendly conversation.`,
  createdAt: new Date(Date.UTC(2026, 9, 9, 9, index)).toISOString(), readAt: index % 3 === 1 ? "2026-10-09T12:00:00Z" : null,
})));
if (new URLSearchParams(window.location.search).has("preview")) {
  const conversation = [
    [false, "Hey! Are we still meeting tomorrow?"],
    [true, "Yes, absolutely. Does 10:30 work for you?"],
    [false, "Perfect. Let's meet at the cafe near the office."],
    [true, "Sounds good! I'll bring the notes from our last discussion."],
    [false, "Great, thank you. We can go through the next steps together."],
    [true, "See you tomorrow 😊"],
  ] as const;
  rows.set("maya", conversation.map(([senderIsViewer, content], index) => ({
    id: `preview-${index}`, conversationId: "maya", senderIsViewer, content,
    createdAt: new Date(Date.UTC(2026, 9, 19, 9, 30 + index)).toISOString(),
    readAt: senderIsViewer ? "2026-10-19T10:00:00Z" : null,
  })));
}
function conversation(id: string): DirectMessageConversation {
  return { id, peerPersonRef: id === "maya" ? "person-maya" : id, peerDisplayName: id === "maya" ? "Maya Rao" : id === "leah" ? "Leah Roy" : "Arjun Mehta with a very long display name",
    peerPhotoUrl: id === "maya" ? "/fixture-person-0.webp" : "/fixture-person-1.webp", createdAt: rows.get(id)![0]?.createdAt ?? "2026-10-09T09:00:00Z",
    lastMessageAt: rows.get(id)!.at(-1)?.createdAt ?? null, latestMessage: rows.get(id)!.at(-1) ?? null, unreadCount: rows.get(id)!.filter((item) => !item.senderIsViewer && !item.readAt).length };
}
// A selected public person reference is distinct from the existing thread ID.
const conversationIdForPerson = (personRef: string) => personRef === "person-maya" ? "maya" : personRef;
const sends: { recipientPersonRef: string; content: string; clientMessageId: string; replyToMessageId?: string; attachment?: File }[] = [];
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
const routeRequests: { conversationId?: string; personRef?: string }[] = [];
let failRouteMint = false;
const fixture = {
  sends, reads, deliveries,
  routeRequests,
  failNextRouteMint: () => { failRouteMint = true; },
  holdReaction: () => { delayReaction = true; },
  releaseReaction: () => { delayReaction = false; settleReaction?.(); settleReaction = null; },
  holdOlder: () => { delayOlder = true; }, olderPending: () => olderPending,
  releaseOlder: () => { delayOlder = false; settleOlder?.(); settleOlder = null; },
  quoteOldest: () => {
    const items = rows.get("maya")!;
    items.at(-1)!.replyTo = { id: items[0]!.id, content: items[0]!.content, senderIsViewer: false, deletedForEveryoneAt: null };
    dispatchDirectMessagesUpdated({ userId: "fixture-owner", conversationId: "maya", messageId: "quote", source: "sse" });
  },
  addPhoto: () => {
    const items = rows.get("maya")!, id = `fixture-photo-${items.length}`;
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300;
    const context = canvas.getContext("2d")!; context.fillStyle = "#EAF4FF"; context.fillRect(0, 0, 400, 300);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), value => value.charCodeAt(0));
    attachments.set(id, new Blob([bytes], { type: "image/png" }));
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    pendingPhotos.set(id, { wait, release, started: false });
    items.push({ id, conversationId: "maya", content: "", senderIsViewer: false,
      createdAt: new Date(Date.parse(items.at(-1)!.createdAt) + 60000).toISOString(), readAt: null,
      attachment: { kind: "photo", name: "Photo.png", mimeType: "image/png", size: bytes.length } });
    dispatchDirectMessagesUpdated({ userId: "fixture-owner", conversationId: "maya", messageId: id, source: "sse" });
    return id;
  },
  photoPending: () => [...pendingPhotos.values()].some(photo => photo.started),
  releasePhotos: () => { for (const photo of pendingPhotos.values()) photo.release(); },
  addFiles: () => {
    const bytes = new Uint8Array(44 + 128000), view = new DataView(bytes.buffer);
    for (const [offset, tag] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) bytes.set(new TextEncoder().encode(tag), offset);
    view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 128000, true);
    for (let offset = 44; offset < bytes.length; offset += 2) view.setInt16(offset, Math.sin(offset / 24) * 8000, true);
    for (const [id, blob, attachment, senderIsViewer] of [
      ["fixture-file", new Blob(["%PDF-fixture"], { type: "application/pdf" }), { kind: "document", name: "Chat_Spec_v2.pdf", mimeType: "application/pdf", size: 12 }, false],
      ["fixture-audio", new Blob([bytes], { type: "audio/wav" }), { kind: "audio", name: "Voice message.wav", mimeType: "audio/wav", size: bytes.length, durationMs: 4000 }, true],
    ] as const) {
      attachments.set(id, blob);
      const items = rows.get("maya")!;
      items.push({ id, conversationId: "maya", content: "", senderIsViewer, createdAt: new Date(Date.parse(items.at(-1)!.createdAt) + 60000).toISOString(), readAt: null, deliveredAt: senderIsViewer ? new Date().toISOString() : null, attachment });
    }
    dispatchDirectMessagesUpdated({ userId: "fixture-owner", conversationId: "maya", messageId: "fixture-files", source: "sse" });
  },
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
      createdAt: new Date(Date.parse(items.at(-1)?.createdAt ?? "2026-10-09T12:00:00Z") + 60_000).toISOString(), readAt: null };
    items.push(message); dispatchDirectMessagesUpdated({ userId: "fixture-owner", conversationId: id, messageId: message.id, source: "sse" }); return message.id;
  },
};
(window as unknown as { directChatFixture: typeof fixture }).directChatFixture = fixture;
export class DirectMessagesService {
  static async routeSelection(input: { token?: string; conversationId?: string; personRef?: string }) {
    const kind = input.personRef || input.token?.startsWith("dm1.person.") ? "person" : "conversation";
    const ref = input.token?.replace(/^dm1\.(?:person\.)?/, "") ?? input.conversationId ?? input.personRef ?? "maya";
    return { token: `dm1.${kind === "person" ? "person." : ""}${ref}`, kind, ref };
  }
  static async routeHref(input: { conversationId?: string; personRef?: string }) {
    routeRequests.push({ conversationId: input.conversationId, personRef: input.personRef });
    if (failRouteMint) { failRouteMint = false; throw new Error("Synthetic route service unavailable"); }
    return `/one/messages?token=dm1.${input.conversationId ?? `person.${input.personRef}`}`;
  }

  static async listConversations() {
    if (delayInbox) await new Promise<void>((resolve) => { settleInbox = resolve; });
    const items = [conversation("maya"), conversation("arjun")].filter(item => item.latestMessage);
    if (overflowingInbox) {
      items.push(...Array.from({ length: 30 }, (_, index) => ({ ...conversation("arjun"), id: `extra-${index}`, peerDisplayName: `Connection ${index + 1}` })));
    }
    return { items, unreadCount: conversation("maya").unreadCount + conversation("arjun").unreadCount };
  }
  static async getConversationMessages(input: { conversationId: string; before?: string; limit?: number }) {
    const items = rows.get(input.conversationId)!;
    const filtered = input.before ? items.slice(0, items.findIndex((item) => item.id === input.before)) : items;
    const page = filtered.slice(-60);
    const result = { conversation: { ...conversation(input.conversationId), unreadCount: 0 }, items: page.map((item) => ({ ...item })), canSend: true, disconnectedNotice: null,
      nextBefore: filtered.length > 60 ? page[0]!.id : null };
    if (input.before && delayOlder && !olderPending) { olderPending = true; await new Promise<void>(resolve => { settleOlder = resolve; }); olderPending = false; }
    if (delayHistory) { pendingHistory = true; await new Promise<void>((resolve) => { settleHistory = resolve; }); pendingHistory = false; }
    return result;
  }
  static async acknowledgeDelivery(input: { conversationId: string; messageIds: string[]; isEffectCurrent: () => boolean }) {
    if (!input.isEffectCurrent()) return;
    deliveries.push({ conversationId: input.conversationId, messageIds: input.messageIds });
    for (const item of rows.get(input.conversationId)!) if (input.messageIds.includes(item.id) && !item.senderIsViewer) item.deliveredAt ??= new Date().toISOString();
  }
  static async getAttachment(input: { messageId: string }) {
    const photo = pendingPhotos.get(input.messageId);
    if (photo) { photo.started = true; await photo.wait; }
    return attachments.get(input.messageId)!;
  }
  static async getConversationWithPerson(input: { personRef: string }) {
    const conversationId = conversationIdForPerson(input.personRef);
    const existing = rows.has(conversationId) ? conversation(conversationId) : null;
    if (!existing && input.personRef !== "leah") throw new Error("Unknown synthetic connection");
    return { conversation: existing, peerPersonRef: input.personRef,
      peerDisplayName: existing?.peerDisplayName ?? "Leah Roy",
      peerPhotoUrl: existing?.peerPhotoUrl ?? null, canSend: true };
  }
  static async sendMessage(input: typeof sends[number]) {
    sends.push({ ...input });
    if (delaySend) await new Promise<void>((resolve) => { settleSend = resolve; });
    const conversationId = conversationIdForPerson(input.recipientPersonRef);
    const items = rows.get(conversationId) ?? [];
    rows.set(conversationId, items);
    let message = items.find((item) => item.id === input.clientMessageId);
    if (!message) { message = { id: input.clientMessageId, conversationId, senderIsViewer: true, content: input.content,
      createdAt: new Date(Date.parse(items.at(-1)?.createdAt ?? "2026-10-09T12:00:00Z") + 60_000).toISOString(), readAt: null }; items.push(message); }
    if (input.attachment) {
      attachments.set(message.id, input.attachment);
      message.attachment = { kind: "photo", name: input.attachment.name, mimeType: input.attachment.type, size: input.attachment.size };
    }
    if (input.replyToMessageId) {
      const reply = items.find((item) => item.id === input.replyToMessageId)!;
      message.replyTo = { id: reply.id, content: reply.content, senderIsViewer: reply.senderIsViewer, deletedForEveryoneAt: reply.deletedForEveryoneAt ?? null };
    }
    if (loseResponse) { loseResponse = false; throw new Error("Delivery is unconfirmed. Try again."); }
    return { message: { ...message }, conversation: conversation(conversationId) };
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
  static async deleteConversation(input: { conversationId: string }) {
    rows.set(input.conversationId, []);
    return { conversationId: input.conversationId, deleted: true, scope: "me" };
  }
  static async deleteMessage(input: { conversationId: string; messageId: string; scope: "me" | "everyone" }) {
    const items = rows.get(input.conversationId)!;
    const message = items.find((item) => item.id === input.messageId)!;
    if (input.scope === "me") { rows.set(input.conversationId, items.filter((item) => item.id !== message.id)); return { scope: input.scope, message: null }; }
    Object.assign(message, { content: "", deletedForEveryoneAt: new Date().toISOString() }); return { scope: input.scope, message: { ...message } };
  }
  static async reactToMessage(input: { conversationId: string; messageId: string; emoji: string }) {
    const message = rows.get(input.conversationId)!.find((item) => item.id === input.messageId)!;
    message.reactions = [{ emoji: input.emoji, count: 1, reactedByViewer: true }];
    if (delayReaction) await new Promise<void>(resolve => { settleReaction = resolve; });
    return { ...message };
  }
  static async removeReaction(input: { conversationId: string; messageId: string; emoji: string }) {
    const message = rows.get(input.conversationId)!.find((item) => item.id === input.messageId)!;
    message.reactions = (message.reactions ?? []).flatMap(reaction => {
      if (reaction.emoji !== input.emoji || !reaction.reactedByViewer) return [reaction];
      return reaction.count > 1 ? [{ ...reaction, count: reaction.count - 1, reactedByViewer: false }] : [];
    });
    return { ...message };
  }
  static async openEvents() { return new Response(new ReadableStream({ start() {} }), { status: 200 }); }
}
