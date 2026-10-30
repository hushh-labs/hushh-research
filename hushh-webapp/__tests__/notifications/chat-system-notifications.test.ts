import { expect, it, vi } from "vitest";
import { ChatSystemNotifications } from "@/lib/notifications/chat-system-notifications";
const identity = vi.hoisted(() => ({ key: "alice-key" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/notifications/preview-keys", () => ({ activeNotificationKeyId: () => identity.key }));
it("discards the old key's read cleanup after an asynchronous lookup", async () => {
  identity.key = "alice-key";
  let release!: (value: unknown) => void;
  const close = vi.fn(); const postMessage = vi.fn();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: () => new Promise(resolve => { release = resolve; }) } });
  const reading = ChatSystemNotifications.clearRead({ keyId: "alice-key", threadId: "circle", sequence: 10, badgeCount: 0 });
  identity.key = "bob-key";
  release({ active: { postMessage }, getNotifications: async () => [{ data: { recipient_key_id: "bob-key", circle_id: "circle", chat_sequence: 9 }, close }] });
  await reading;
  expect(close).not.toHaveBeenCalled(); expect(postMessage).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, "serviceWorker");
});
it("clears covered cards without clearing a later message in the same millisecond", async () => {
  identity.key = "alice-key";
  const covered = vi.fn(); const tiedLater = vi.fn(); const postMessage = vi.fn();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ active: { postMessage }, getNotifications: async () => [
    { data: { recipient_key_id: "alice-key", conversation_id: "thread", message_id: "direct-message:read", chat_sent_at: 1000 }, close: covered },
    { data: { recipient_key_id: "alice-key", conversation_id: "thread", message_id: "direct-message:later", chat_sent_at: 1000 }, close: tiedLater },
  ] }) } });
  await ChatSystemNotifications.clearRead({ keyId: "alice-key", threadId: "thread", before: 999, messageId: "direct-message:read" });
  expect(covered).toHaveBeenCalledOnce(); expect(tiedLater).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "hushh:chat_read", before: 999 }));
  Reflect.deleteProperty(navigator, "serviceWorker");
});
