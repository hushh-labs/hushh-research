import { createContext } from "react";
export const useAuth = () => ({ user: { uid: "alice" } });
export const VaultContext = createContext({ vaultOwnerToken: "fixture", vaultKey: "fixture" });
export const OneLocationService = { listCircles: async () => [{ id: "circle", name: "Weekend friends", kind: "friends", role: "owner", memberCount: 2, memberLimit: null }] };
// Layout/failure fixture adapter only. The spec renders the production chat,
// shared controls, lifecycle coordinator and image viewer with the app CSS.
import { ApiError } from "../../lib/services/api-client";
declare const __CIRCLE_CHAT_FIXTURE_MEDIA__: string;
type FixtureMessage = { id: string; sequence: number; senderUserId: string; senderName: string; createdAt: string; text: string; image: boolean; revision?: number; replyToMessageId?: string; editedAt?: string; deletedForEveryoneAt?: string };
const history: FixtureMessage[] = Array.from({ length: 45 }, (_, index) => ({
  id: `message-${index}`, sequence: index + 1, senderUserId: index % 2 ? "alice" : "bob",
  senderName: "A member with a long display name", createdAt: "2026-10-02T10:00:00Z",
  text: index === 44 ? "LongText".repeat(100) : `Message ${index + 1} with a friendly reply.`, image: index === 44,
}));
if (new URLSearchParams(location.search).has("workspace")) {
  history.splice(0, history.length,
    { id: "hello", sequence: 1, senderUserId: "bob", senderName: "Kushal Trivedi", createdAt: "2026-10-02T10:00:00Z", text: "Hey everyone! Great to have us all here.", image: false },
    { id: "reply", sequence: 2, senderUserId: "alice", senderName: "Neelesh Meena", createdAt: "2026-10-02T10:01:00Z", text: "Absolutely. Looking forward to connecting!", image: false },
    { id: "photo", sequence: 3, senderUserId: "bob", senderName: "Kushal Trivedi", createdAt: "2026-10-02T10:02:00Z", text: "Our next meetup spot 📍", image: true },
  );
}
let failed = false;
let muted = false;
type Reaction = { emoji: string; count: number; reactedByViewer: boolean };
const reactions = new Map<string, Reaction[]>();
const hidden = new Set<string>();
const fixture = window as unknown as { chatFixture: { failNext: boolean; failNextReaction: boolean; failNextMute: boolean; failNextMutation: boolean; sends: unknown[]; mutations: unknown[]; read: number[]; loseAccess: boolean; prepareDelayMs: number; sendDelayMs: number; imageMessageIds: string[] } };
fixture.chatFixture = { failNext: false, failNextReaction: false, failNextMute: false, failNextMutation: false, sends: [], mutations: [], read: [], loseAccess: false, prepareDelayMs: 0, sendDelayMs: 0, imageMessageIds: [] };
const visible = () => history.filter(row => !hidden.has(row.id));
function mutate(message: { id: string }, payload: { text?: string }, scope: string) {
  fixture.chatFixture.mutations.push({ id: message.id, payload, scope });
  if (fixture.chatFixture.failNextMutation) { fixture.chatFixture.failNextMutation = false; throw new ApiError("Timed out", 504); }
  const row = history.find(item => item.id === message.id)!;
  if (scope === "me") { hidden.add(row.id); return { hiddenId: row.id }; }
  row.revision = (row.revision ?? 0) + 1;
  row.text = payload.text ?? "This message was deleted.";
  if (scope === "everyone") { row.deletedForEveryoneAt = new Date().toISOString(); row.image = false; }
  else row.editedAt = new Date().toISOString();
  return { items: [{ ...row }] };
}
Object.assign(fixture.chatFixture, { incoming: () => {
  history.push({ id: `incoming-${history.length}`, sequence: history.length + 1, senderUserId: "bob", senderName: "Kushal Trivedi", createdAt: new Date().toISOString(), text: "Incoming while reading history", image: false });
  window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: "alice", circleId: "circle" } }));
} });
export const CircleChatService = {
  initialize: async () => undefined,
  wait: () => new Promise(() => {}),
  state: async () => ({ unreadCount: 1, latestSequence: history.at(-1)!.sequence, muted }),
  messages: async (_session: unknown, cursor: { before?: number; after?: number } = {}) => {
    if (fixture.chatFixture.loseAccess) throw new ApiError("Circle unavailable", 404, { detail: { code: "CIRCLE_CHAT_UNAVAILABLE" } });
    const rows = visible().filter((m) => (!cursor.before || m.sequence < cursor.before) && (!cursor.after || m.sequence > cursor.after));
    return { items: (cursor.after ? rows.slice(0, 40) : rows.slice(-40)).map((row) => ({ ...row,
      reactions: reactions.get(row.id) ?? [], senderPhotoUrl: row.senderUserId === "alice" ? "/fixture-person-0.webp" : "/fixture-person-1.webp" })), hasMore: rows.length > 40,
      receipts: history.filter((row) => row.senderUserId === "alice").map((row) => ({ id: row.id, recipientCount: 5, readCount: 5 })) };
  },
  resolve: async (_session: unknown, ids: string[]) => ({ items: visible().filter(row => ids.includes(row.id)) }),
  updates: async (_session: unknown, ids: string[]) => ({ states: history.filter(row => ids.includes(row.id)).map(row => ({ id: row.id, revision: row.revision ?? 0, hidden: hidden.has(row.id), deletedForEveryoneAt: row.deletedForEveryoneAt ?? null })), unavailableIds: [] }),
  sealMutation: async (_session: unknown, _message: unknown, content: { text: string }) => ({ ...content, ciphertext: "opaque", iv: "opaque", expectedRevision: 0 }),
  edit: async (_session: unknown, message: { id: string }, payload: { text: string }) => mutate(message, payload, "edit"),
  delete: async (_session: unknown, message: { id: string }, scope: string, payload?: { text: string }) => mutate(message, payload ?? {}, scope),
  open: async (_session: unknown, message: typeof history[number]) => ({ text: message.text,
    image: message.image ? { name: "family.png", type: "image/png" } : null }),
  prepare: async (_session: unknown, text: string, file: File | null, preview?: { clientMessageId?: string; replyToMessageId?: string }) => {
    if (fixture.chatFixture.prepareDelayMs) await new Promise((resolve) => setTimeout(resolve, fixture.chatFixture.prepareDelayMs));
    return { clientMessageId: preview?.clientMessageId ?? "retry-id", text, image: Boolean(file), ...(preview?.replyToMessageId ? { replyToMessageId: preview.replyToMessageId } : {}) };
  },
  send: async (_session: unknown, payload: { text: string; image: boolean }) => {
    fixture.chatFixture.sends.push(payload);
    if (fixture.chatFixture.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, fixture.chatFixture.sendDelayMs));
    if (fixture.chatFixture.failNext && !failed) { failed = true; throw new ApiError("Delivery timed out", 504); }
    const message = { id: `message-${history.length}`, sequence: history.length + 1, senderUserId: "alice", senderName: "Alice", createdAt: new Date().toISOString(), ...payload };
    history.push(message);
    return message;
  },
  read: async (_session: unknown, sequence: number) => { fixture.chatFixture.read.push(sequence); },
  react: async (_session: unknown, message: { id: string }, emoji: string, active: boolean) => {
    if (fixture.chatFixture.failNextReaction) { fixture.chatFixture.failNextReaction = false; throw new ApiError("Reaction timed out", 504); }
    const current = (reactions.get(message.id) ?? []).filter((item) => item.emoji !== emoji);
    if (active) current.push({ emoji, count: 1, reactedByViewer: true });
    reactions.set(message.id, current);
    return { messageId: message.id, reactions: current };
  },
  mute: async (_session: unknown, nextMuted: boolean) => {
    if (fixture.chatFixture.failNextMute) { fixture.chatFixture.failNextMute = false; throw new ApiError("Chat alerts could not be updated.", 503); }
    muted = nextMuted;
    return { muted };
  },
  image: async (_session: unknown, message: { id: string }) => { fixture.chatFixture.imageMessageIds.push(message.id); return new Blob([Uint8Array.from(atob(__CIRCLE_CHAT_FIXTURE_MEDIA__), (c) => c.charCodeAt(0))], { type: "image/webp" }); },
};
